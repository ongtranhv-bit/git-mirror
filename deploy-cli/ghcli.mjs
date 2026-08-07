#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`ghcli: ${message}`);
  process.exit(2);
}

function usage() {
  console.log("Usage: node deploy-cli/ghcli.mjs [--repo OWNER/REPO] [--dry-run] FILE.env");
}

function parseArgs(argv) {
  let envFile = "";
  let repository = "";
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      index += 1;
      if (!argv[index]) fail("--repo requires OWNER/REPO");
      repository = argv[index];
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
  return { envFile, repository, dryRun };
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
  "GHCLI_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GHCLI_REPO", "GHCLI_REPOSITORY",
]);
const targetNames = new Set([
  "repo-and-codespaces-secret", "repo-secret", "codespaces-secret", "repo-variable",
]);
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

const token = controls.get("GHCLI_TOKEN") || controls.get("GH_TOKEN") || controls.get("GITHUB_TOKEN");
if (!token) fail(`set GHCLI_TOKEN (or GH_TOKEN/GITHUB_TOKEN) in ${options.envFile}`);
const repository = options.repository
  || controls.get("GHCLI_REPO")
  || controls.get("GHCLI_REPOSITORY")
  || "";
const repoArgs = repository ? ["-R", repository] : [];

function publish(target, name, value) {
  let args;
  if (target === "repo-secret") {
    args = ["secret", "set", name, "--app", "actions", ...repoArgs];
  } else if (target === "codespaces-secret") {
    args = ["secret", "set", name, "--app", "codespaces", ...repoArgs];
  } else if (target === "repo-variable") {
    args = ["variable", "set", name, ...repoArgs];
  } else {
    fail(`internal error: unsupported target ${target}`);
  }

  if (options.dryRun) {
    console.log(`Would update ${target.padEnd(17)} ${name}`);
    return;
  }
  const result = spawnSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token },
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) {
    fail(result.error.code === "ENOENT"
      ? "GitHub CLI (gh) is required and must be in PATH"
      : `cannot run GitHub CLI: ${result.error.message}`);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Updated ${target.padEnd(17)} ${name}`);
}

let pendingTarget = "";
let pendingLine = 0;
let updated = 0;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const lineNumber = index + 1;
  const annotation = line.match(/^\s*#\s*ghcli:([a-z-]+)\s*$/);
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

  if (pendingTarget === "repo-and-codespaces-secret") {
    publish("repo-secret", assignment.name, assignment.value);
    publish("codespaces-secret", assignment.name, assignment.value);
  } else {
    publish(pendingTarget, assignment.name, assignment.value);
  }
  pendingTarget = "";
  updated += 1;
}
if (pendingTarget) fail(`line ${pendingLine} annotation has no variable`);
console.log(`Done: ${updated} value(s) processed.`);
