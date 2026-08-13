#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import prompts from "prompts";
import {
  listRuns as ghListRuns,
  runWorkflow,
  stopRun as ghStopRun,
  fetchJobLog,
  listJobs,
  fetchRunStatus,
  listRepos,
  pickRepo,
  pickRun as ghPickRun,
  pickWorkflow,
} from "./gh-actions.mjs";
import {
  listPipelines,
  listRepos as azListRepos,
  pickPipeline,
  pickProject,
  pickRun as azPickRun,
  runPipeline,
  stopRun as azStopRun,
  fetchTaskLog,
  fetchRunState,
  timelineRecords,
  requireAzure,
} from "./azure-pipelines.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(scriptDir, ".env");

function fail(message) {
  console.error(`menu: ${message}`);
  process.exit(2);
}

if (!process.stdin.isTTY) {
  fail("menu.mjs cần terminal tương tác — dùng CLI trực tiếp: gh-actions.mjs / azure-pipelines.mjs");
}

function parseEnvFile(file) {
  const values = {};
  try {
    const content = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      } else if (value.startsWith("'")) {
        if (value.length >= 2 && value.endsWith("'")) value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      if (value) values[match[1]] = value;
    }
  } catch {
    // no env file
  }
  return values;
}

const envValues = parseEnvFile(ENV_FILE);
const ghToken = process.env.GH_TOKEN || process.env.GHCLI_TOKEN || envValues.GHCLI_TOKEN;
const azureEnv = {
  token: process.env.AZURE_DEVOPS_TOKEN || envValues.AZURECLI_TOKEN,
  org: process.env.AZURECLI_ORG || envValues.AZURECLI_ORG,
};
const azure = azureEnv.token && azureEnv.org ? azureEnv : null;
const defaultRepo = process.env.GHCLI_REPO || envValues.GHCLI_REPO;

async function askToken(kind) {
  if (kind === "github" && ghToken) return ghToken;
  if (kind === "azure" && azure.token) return azure;
  if (kind === "github") {
    const { value } = await prompts({
      type: "text",
      name: "value",
      message: "Nhập GitHub token (chỉ dùng trong phiên này, không lưu):",
    });
    if (!value) fail("Cần GitHub token");
    return value;
  }
  const { value: token } = await prompts({
    type: "text",
    name: "value",
    message: "Nhập Azure DevOps PAT (chỉ dùng trong phiên này, không lưu):",
  });
  const { value: org } = await prompts({
    type: "text",
    name: "value",
    message: "Azure organization (VD: myorg, không cần dev.azure.com):",
  });
  if (!token || !org) fail("Cần Azure PAT và organization");
  return { token, org };
}

async function confirmContinue(label) {
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: `Đã xong: ${label} — chọn hành động tiếp theo`,
    choices: [
      { title: "🔄 Chạy lại lệnh vừa chạy", value: "replay" },
      { title: "➡️  Chạy tiếp lệnh khác", value: "next" },
      { title: "🚪 Thoát", value: "exit" },
    ],
  });
  return value;
}

async function withReplay(label, action) {
  for (;;) {
    await action();
    const choice = await confirmContinue(label);
    if (choice === "exit") process.exit(0);
    if (choice === "next") return;
  }
}

function printTable(rows) {
  for (const row of rows) console.log(row);
}

async function runGhCli(file) {
  await runChild("node", [join(scriptDir, "ghcli.mjs"), file]);
}

async function runAzureCli(file) {
  await runChild("node", [join(scriptDir, "azurecli.mjs"), file]);
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

function listEnvFiles() {
  return readdirSync(scriptDir)
    .filter((name) => name.endsWith(".env") && name !== ".env.example")
    .map((name) => join(scriptDir, name));
}

async function secretsMenu() {
  const { value: provider } = await prompts({
    type: "select",
    name: "value",
    message: "Cập nhật secrets cho nền tảng nào?",
    choices: [
      { title: "GitHub (ghcli.mjs — repo & codespaces secrets)", value: "github" },
      { title: "Azure Pipelines (azurecli.mjs — variable group)", value: "azure" },
      { title: "⬅️  Quay lại", value: "back" },
    ],
  });
  if (provider === "back") return;
  const files = listEnvFiles();
  if (files.length === 0) {
    console.log("Không có file *.env trong deploy-cli/ — tạo deploy-cli/.env rồi thử lại.");
    return;
  }
  const { value: file } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn file env",
    choices: files.map((path) => ({ title: path, value: path })),
  });
  const { value: dryRun } = await prompts({
    type: "toggle",
    name: "value",
    message: "Chạy thử (--dry-run) trước?",
    initial: true,
    active: "Có",
    inactive: "Không",
  });
  const label = provider === "github" ? "GitHub secrets" : "Azure variables";
  await withReplay(`${label} từ ${file}`, async () => {
    if (provider === "github") await runGhCli(file);
    else await runAzureCli(file);
    if (dryRun) console.log("(dry-run — không có gì thay đổi)");
  });
}

async function pickEnvRepo(token) {
  const explicit = process.env.GHCLI_REPO || envValues.GHCLI_REPO;
  if (explicit) {
    const { value } = await prompts({
      type: "toggle",
      name: "value",
      message: `Dùng repo cấu hình sẵn: ${explicit}?`,
      initial: true,
      active: "Có",
      inactive: "Không (chọn từ danh sách)",
    });
    if (value) return explicit;
  }
  return pickRepo(token);
}

async function githubMenu() {
  const token = ghToken || (await askToken("github"));
  const repo = await pickEnvRepo(token);
  console.log(`\n📦 Repository: ${repo}`);

  const { value: action } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn thao tác",
    choices: [
      { title: "▶️  Run workflow", value: "run" },
      { title: "📜 List runs", value: "runs" },
      { title: "🛑 Stop run", value: "stop" },
      { title: "📄 Xem log run", value: "log" },
      { title: "📋 List workflows (yml)", value: "workflows" },
      { title: "🔑 Set secrets (ghcli)", value: "secrets" },
      { title: "🔄 Đổi repository", value: "change-repo" },
      { title: "⬅️  Về menu chính", value: "back" },
    ],
  });

  switch (action) {
    case "change-repo":
      return githubMenu();
    case "back":
      return;
    case "workflows": {
      const workflows = await listWorkflowsShown(token, repo);
      printTable(workflows.map((workflow) => `${workflow.id}\t${workflow.name}\t${workflow.path}`));
      await withReplay("List workflows", async () => {
        const { value: wf } = await prompts({
          type: "select",
          name: "value",
          message: "Workflow (Enter lại để refresh)",
          choices: workflows.map((workflow) => ({ title: workflow.path, value: workflow })),
        });
        const { value: confirm } = await prompts({
          type: "toggle",
          name: "value",
          message: `Run ngay workflow ${wf.path}?`,
          active: "Có",
          inactive: "Không",
        });
        if (confirm) await runWorkflowFlow(token, repo, wf);
      });
      return githubMenu();
    }
    case "run":
      await withReplay("Run workflow", () => runWorkflowFlow(token, repo));
      return githubMenu();
    case "runs": {
      const runs = await ghListRuns(token, repo);
      printTable(runs.map((run) => `#${run.number}\t${run.id}\t${run.event}\t${run.branch}\t${run.sha}\t${run.status}\t${run.conclusion}\t${run.createdAt}`));
      if (runs.length === 0) return githubMenu();
      const selected = await ghPickRun(runs);
      await runMenu(token, repo, selected);
      return githubMenu();
    }
    case "stop":
      await withReplay("Stop run", async () => {
        const runs = await ghListRuns(token, repo);
        const selected = await ghPickRun(runs.filter((run) => run.status !== "completed"), "Chọn run đang chạy để stop");
        await ghStopRun(token, repo, selected.id);
        console.log(`Đã cancel run #${selected.number} (${selected.id})`);
      });
      return githubMenu();
    case "log":
      await withReplay("Xem log", async () => {
        const runs = await ghListRuns(token, repo);
        const selected = await ghPickRun(runs, "Chọn run để xem log");
        await ghLogFlow(token, repo, selected);
      });
      return githubMenu();
    case "secrets":
      await secretsMenu();
      return githubMenu();
    default:
      return;
  }
}

async function listWorkflowsShown(token, repo) {
  const { listWorkflows } = await import("./gh-actions.mjs");
  return listWorkflows(token, repo);
}

async function runWorkflowFlow(token, repo, presetWorkflow) {
  const workflow = presetWorkflow || (await pickWorkflow(token, repo));
  const { value: ref } = await prompts({
    type: "text",
    name: "value",
    message: "Branch/ref để run",
    initial: "main",
  });
  const { value: inputs } = await prompts({
    type: "text",
    name: "value",
    message: "Inputs (k=v, cách nhau bằng dấu phẩy — bỏ trống nếu không có)",
  });
  const parsed = parsePairs(inputs);
  const result = await runWorkflow(token, repo, workflow.path, ref || "main", parsed);
  console.log(`✅ Đã dispatch ${result.workflow} trên ${repo}@${ref || "main"}${Object.keys(parsed).length ? ` inputs=${JSON.stringify(parsed)}` : ""}`);
}

async function runMenu(token, repo, run) {
  const { value: action } = await prompts({
    type: "select",
    name: "value",
    message: `Run #${run.number} [${run.status} ${run.conclusion}] — chọn thao tác`,
    choices: [
      { title: "📄 Xem log", value: "log" },
      { title: "🛑 Stop run", value: "stop" },
      { title: "🔄 Follow trạng thái", value: "follow" },
      { title: "⬅️  Quay lại", value: "back" },
    ],
  });
  if (action === "back") return;
  if (action === "log") {
    await ghLogFlow(token, repo, run);
    return runMenu(token, repo, run);
  }
  if (action === "stop") {
    await ghStopRun(token, repo, run.id);
    console.log(`Đã cancel run #${run.number}`);
    return;
  }
  await withReplay(`Follow run #${run.number}`, async () => {
    let previous = "";
    for (;;) {
      const { status, conclusion } = await fetchRunStatus(token, repo, run.id);
      const line = `${status}${conclusion ? ` ${conclusion}` : ""}`;
      if (line !== previous) {
        console.log(`Run #${run.number}: ${line}`);
        previous = line;
      }
      if (status === "completed") break;
      await sleep(10_000);
    }
  });
}

async function ghLogFlow(token, repo, run) {
  const jobs = await listJobs(token, repo, run.id);
  const selected = jobs.length === 1 ? jobs[0] : (await prompts({
    type: "select",
    name: "value",
    message: "Chọn job",
    choices: jobs.map((job) => ({ title: `${job.name} [${job.status} ${job.conclusion}]`, value: job })),
    limit: 15,
  })).value;
  try {
    const log = await fetchJobLog(token, repo, selected.id);
    console.log(`\n📄 Log job "${selected.name}" (run #${run.number}):\n`);
    console.log(log);
  } catch (error) {
    console.error(`⚠️  ${error.message}`);
    console.log("Gợi ý: log chỉ xem được khi job đã chạy xong (GitHub API); dùng --follow để theo trạng thái.");
  }
}

async function azureMenu() {
  const azure2 = azure ?? (await askToken("azure"));
  const project = await pickProject(azure2.token, azure2.org);
  console.log(`\n📦 Project: ${project} (org: ${azure2.org})`);
  const pipeline = await pickPipeline(azure2.token, azure2.org, project);
  console.log(`📋 Pipeline: ${pipeline.name} (id ${pipeline.id})`);

  const { value: action } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn thao tác",
    choices: [
      { title: "▶️  Run pipeline", value: "run" },
      { title: "📜 List runs", value: "runs" },
      { title: "🛑 Stop run", value: "stop" },
      { title: "📄 Xem log run", value: "log" },
      { title: "🔄 Đổi pipeline", value: "change-pipeline" },
      { title: "⬅️  Về menu chính", value: "back" },
    ],
  });

  switch (action) {
    case "change-pipeline":
      return azureMenu();
    case "back":
      return;
    case "run":
      await withReplay("Run pipeline", async () => {
        const { value: branch } = await prompts({
          type: "text",
          name: "value",
          message: "Branch để run",
          initial: "main",
        });
        const { value: variables } = await prompts({
          type: "text",
          name: "value",
          message: "Variables (k=v, cách nhau bằng dấu phẩy — bỏ trống nếu không có)",
        });
        const run = await runPipeline(azure2.token, azure2.org, project, pipeline.id, branch || "main", parsePairs(variables));
        console.log(`✅ Đã start run ${run.id} (${run.name}) cho pipeline ${pipeline.id}@${branch || "main"}`);
      });
      return azureMenu();
    case "runs": {
      const runs = await listAzureRuns(azure2, project, pipeline.id);
      printTable(runs.map((run) => `${run.id}\t${run.name}\t${run.state}\t${run.result}\t${run.createdDate}`));
      if (runs.length === 0) return azureMenu();
      const selected = await azPickRun(azure2, project, pipeline.id);
      await azureRunMenu(azure2, project, pipeline, selected);
      return azureMenu();
    }
    case "stop":
      await withReplay("Stop run", async () => {
        const runs = await listAzureRuns(azure2, project, pipeline.id);
        const active = runs.filter((run) => !["completed", "cancelled"].includes(run.state));
        const selected = await azPickRun(azure2, project, pipeline.id, active.length ? "Chọn run đang chạy để stop" : undefined);
        await azStopRun(azure2.token, azure2.org, project, pipeline.id, selected.id);
        console.log(`Đã cancel run ${selected.id}`);
      });
      return azureMenu();
    case "log":
      await withReplay("Xem log", async () => {
        const selected = await azPickRun(azure2, project, pipeline.id, "Chọn run để xem log");
        await azureLogFlow(azure2, project, pipeline.id, selected);
      });
      return azureMenu();
    default:
      return;
  }
}

async function listAzureRuns(azure2, project, pipelineId) {
  const { listRuns } = await import("./azure-pipelines.mjs");
  return listRuns(azure2.token, azure2.org, project, pipelineId);
}

async function azureRunMenu(azure2, project, pipeline, run) {
  const { value: action } = await prompts({
    type: "select",
    name: "value",
    message: `Run ${run.id} [${run.state} ${run.result}] — chọn thao tác`,
    choices: [
      { title: "📄 Xem log", value: "log" },
      { title: "🛑 Stop run", value: "stop" },
      { title: "🔄 Follow trạng thái", value: "follow" },
      { title: "⬅️  Quay lại", value: "back" },
    ],
  });
  if (action === "back") return;
  if (action === "log") {
    await azureLogFlow(azure2, project, pipeline.id, run);
    return azureRunMenu(azure2, project, pipeline, run);
  }
  if (action === "stop") {
    await azStopRun(azure2.token, azure2.org, project, pipeline.id, run.id);
    console.log(`Đã cancel run ${run.id}`);
    return;
  }
  await withReplay(`Follow run ${run.id}`, async () => {
    let previous = "";
    for (;;) {
      const { state, result } = await fetchRunState(azure2.token, azure2.org, project, pipeline.id, run.id);
      const line = `${state}${result ? ` ${result}` : ""}`;
      if (line !== previous) {
        console.log(`Run ${run.id}: ${line}`);
        previous = line;
      }
      if (state === "completed" || state === "cancelled") break;
      await sleep(10_000);
    }
  });
}

async function azureLogFlow(azure2, project, pipelineId, run) {
  const records = await timelineRecords(azure2.token, azure2.org, project, run.id);
  if (records.length === 0) {
    console.log("Chưa có task log nào cho run này.");
    return;
  }
  const { value: task } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn task",
    choices: records.map((record) => ({
      title: `${record.name} [${record.state} ${record.result}]`,
      value: record,
    })),
    limit: 15,
  });
  try {
    const log = await fetchTaskLog(azure2.token, azure2.org, project, run.id, task.logId);
    console.log(`\n📄 Log task "${task.name}" (run ${run.id}):\n`);
    console.log(log);
  } catch (error) {
    console.error(`⚠️  ${error.message}`);
  }
}

function parsePairs(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    String(raw).split(",").map((pair) => {
      const index = pair.indexOf("=");
      if (index <= 0) throw new Error(`invalid k=v pair: ${pair}`);
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
    }),
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  console.log("=== git-mirror deploy-cli ===\n");
  for (;;) {
    const { value } = await prompts({
      type: "select",
      name: "value",
      message: "Menu chính — chọn nền tảng",
      choices: [
        { title: "🐙 GitHub Actions", value: "github" },
        { title: "☁️  Azure Pipelines", value: "azure" },
        { title: "🔑 Cập nhật secrets (ghcli / azurecli)", value: "secrets" },
        { title: "🚪 Thoát", value: "exit" },
      ],
    });
    if (value === "exit") return;
    if (value === "github") await githubMenu();
    else if (value === "azure") await azureMenu();
    else await secretsMenu();
    console.log();
  }
}

main().catch((error) => {
  console.error(`menu: ${error.message}`);
  process.exit(1);
});