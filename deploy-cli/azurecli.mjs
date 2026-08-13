#!/usr/bin/env node
import { readFileSync } from "node:fs";

const AZURE_API_VERSION = "7.1-preview.1";

function fail(message) {
  console.error(`azurecli: ${message}`);
  process.exit(2);
}

function usage() {
  console.log("Usage: node deploy-cli/azurecli.mjs [--org ORG] [--project PROJECT] [--group-id ID] [--dry-run] FILE.env");
}

function parseArgs(argv) {
  let envFile = "";
  let organization = "";
  let project = "";
  let groupId = "";
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--org") {
      index += 1;
      if (!argv[index]) fail("--org requires a value");
      organization = argv[index];
    } else if (arg === "--project") {
      index += 1;
      if (!argv[index]) fail("--project requires a value");
      project = argv[index];
    } else if (arg === "--group-id") {
      index += 1;
      if (!argv[index]) fail("--group-id requires a value");
      groupId = argv[index];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (envFile) {
      fail("only one env file is accepted");
    } else {
      envFile = arg;
    }
  }
  if (!envFile) {
    usage();
    process.exit(2);
  }
  return { envFile, organization, project, groupId, dryRun };
}

function parseValue(rawValue, name, lineNumber) {
  let value = rawValue.trim();
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      fail(`invalid double-quoted value for ${name} on line ${lineNumber}`);
    }
  } else if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      fail(`invalid single-quoted value for ${name} on line ${lineNumber}`);
    }
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

function parseAssignment(line, lineNumber) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) return null;
  return { name: match[1], value: parseValue(match[2], match[1], lineNumber) };
}

const controlNames = new Set([
  "AZURECLI_TOKEN", "AZURE_DEVOPS_TOKEN", "AZURE_DEVOPS_EXT_PAT",
  "AZURECLI_ORG", "AZURE_ORG",
  "AZURECLI_PROJECT", "AZURE_PROJECT",
  "AZURECLI_GROUP_ID", "AZURE_VARIABLE_GROUP_ID",
  "AZURECLI_GROUP_NAME", "AZURE_VARIABLE_GROUP_NAME",
]);
const targetNames = new Set(["pipeline-secret", "pipeline-variable"]);
const options = parseArgs(process.argv.slice(2));

let content;
try {
  content = readFileSync(options.envFile, "utf8").replace(/^\uFEFF/, "");
} catch (error) {
  fail(`cannot read ${options.envFile}: ${error.message}`);
}
const lines = content.split(/\r?\n/);
const controls = new Map();
for (let index = 0; index < lines.length; index += 1) {
  const assignment = parseAssignment(lines[index], index + 1);
  if (assignment && controlNames.has(assignment.name)) {
    controls.set(assignment.name, assignment.value);
  }
}

const token = controls.get("AZURECLI_TOKEN")
  || controls.get("AZURE_DEVOPS_TOKEN")
  || controls.get("AZURE_DEVOPS_EXT_PAT");
if (!token) fail(`set AZURECLI_TOKEN (or AZURE_DEVOPS_TOKEN/AZURE_DEVOPS_EXT_PAT) in ${options.envFile}`);

const organization = options.organization || controls.get("AZURECLI_ORG") || controls.get("AZURE_ORG") || "";
const project = options.project || controls.get("AZURECLI_PROJECT") || controls.get("AZURE_PROJECT") || "";
const groupId = options.groupId || controls.get("AZURECLI_GROUP_ID") || controls.get("AZURE_VARIABLE_GROUP_ID") || "";
const groupName = controls.get("AZURECLI_GROUP_NAME") || controls.get("AZURE_VARIABLE_GROUP_NAME") || "";
if (!organization) fail("set organization (--org or AZURECLI_ORG/AZURE_ORG)");
if (!project) fail("set project (--project or AZURECLI_PROJECT/AZURE_PROJECT)");
if (!groupId) fail("set variable group id (--group-id or AZURECLI_GROUP_ID/AZURE_VARIABLE_GROUP_ID)");

const baseUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`
  + `/_apis/distributedtask/variablegroups/${encodeURIComponent(groupId)}?api-version=${AZURE_API_VERSION}`;
const headers = {
  Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
  "Content-Type": "application/json",
};

async function fetchVariableGroup() {
  const response = await fetch(baseUrl, { headers });
  if (response.status === 404) return null;
  if (!response.ok) fail(`cannot read variable group ${groupId}: HTTP ${response.status}`);
  return response.json();
}

async function publish(updates) {
  if (options.dryRun) {
    for (const update of updates) {
      console.log(`Would update ${update.isSecret ? "pipeline-secret  " : "pipeline-variable"} ${update.name}`);
    }
    return;
  }
  const group = await fetchVariableGroup();
  const variables = { ...(group?.variables ?? {}) };
  for (const update of updates) {
    variables[update.name] = update.isSecret
      ? { value: update.value, isSecret: true }
      : { value: update.value };
  }
  const body = {
    id: Number(groupId),
    name: group?.name ?? groupName,
    description: group?.description ?? "git-mirror pipeline variables",
    type: group?.type ?? "Vsts",
    variables,
  };
  if (!body.name) fail("variable group not found and AZURECLI_GROUP_NAME is not set");
  const response = await fetch(baseUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) fail(`cannot update variable group ${groupId}: HTTP ${response.status}`);
  for (const update of updates) {
    console.log(`Updated ${update.isSecret ? "pipeline-secret  " : "pipeline-variable"} ${update.name}`);
  }
}

let pendingTarget = "";
let pendingLine = 0;
const updates = [];
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const lineNumber = index + 1;
  const annotation = line.match(/^\s*#\s*azurecli:([a-z-]+)\s*$/);
  if (annotation && targetNames.has(annotation[1])) {
    if (pendingTarget) fail(`line ${pendingLine} annotation has no variable`);
    pendingTarget = annotation[1];
    pendingLine = lineNumber;
    continue;
  }
  if (!pendingTarget || /^\s*$/.test(line) || /^\s*(?:#|\/\/)/.test(line)) continue;

  const assignment = parseAssignment(line, lineNumber);
  if (!assignment) fail(`line ${lineNumber} is not a valid dotenv assignment`);
  if (controlNames.has(assignment.name)) {
    fail(`control variable ${assignment.name} cannot be annotated for upload`);
  }
  if (!assignment.value) fail(`refusing to upload empty value for ${assignment.name}`);

  updates.push({ name: assignment.name, value: assignment.value, isSecret: pendingTarget === "pipeline-secret" });
  pendingTarget = "";
}
if (pendingTarget) fail(`line ${pendingLine} annotation has no variable`);

await publish(updates);
console.log(`Done: ${updates.length} value(s) processed.`);