#!/usr/bin/env node
import prompts from "prompts";

const API_VERSION = "7.1-preview.1";

export async function listProjects(token, org) {
  const { value } = await azureFetch(token, org, "", "_apis/projects", "7.1-preview.4");
  return value.map((project) => ({ id: project.id, name: project.name }));
}

export async function listRepos(token, org, project) {
  const { value } = await azureFetch(token, org, project, "_apis/git/repositories", API_VERSION);
  return value.map((repo) => ({ id: repo.id, name: repo.name }));
}

export async function listPipelines(token, org, project) {
  const { value } = await azureFetch(token, org, project, "_apis/pipelines", API_VERSION);
  return value.map((pipeline) => ({ id: pipeline.id, name: pipeline.name, folder: pipeline.folder ?? "" }));
}

export async function runPipeline(token, org, project, pipelineId, branch, variables) {
  const body = {
    resources: { repositories: { self: { refName: `refs/heads/${branch}` } } },
    ...(variables && Object.keys(variables).length ? { variables } : {}),
  };
  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/pipelines/${pipelineId}/runs?api-version=${API_VERSION}`,
    {
      method: "POST",
      headers: azureHeaders(token),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cannot start pipeline ${pipelineId}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const run = await response.json();
  return { id: run.id, name: run.name };
}

export async function listRuns(token, org, project, pipelineId) {
  const { value } = await azureFetch(token, org, project, `_apis/pipelines/${pipelineId}/runs`, API_VERSION);
  return value.map((run) => ({
    id: run.id,
    name: run.name ?? "",
    state: run.state,
    result: run.result ?? "",
    pipelineName: run.pipeline?.name ?? "",
    createdDate: run.createdDate,
  }));
}

export async function fetchRunState(token, org, project, pipelineId, runId) {
  const run = await azureFetch(token, org, project, `_apis/pipelines/${pipelineId}/runs/${runId}`, API_VERSION);
  return { state: run.state, result: run.result ?? "" };
}

export async function stopRun(token, org, project, pipelineId, runId) {
  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/pipelines/${pipelineId}/runs/${runId}?action=cancel&api-version=${API_VERSION}`,
    { method: "POST", headers: azureHeaders(token) },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cannot cancel run ${runId}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return { ok: true };
}

export async function timelineRecords(token, org, project, runId) {
  const { records } = await azureFetch(token, org, project, `_apis/build/builds/${runId}/timeline`, "7.0");
  return records
    .filter((record) => record.type === "Task" && record.log?.id)
    .map((record) => ({
      id: record.id,
      logId: record.log.id,
      name: record.name,
      state: record.state,
      result: record.result ?? "",
    }));
}

export async function fetchTaskLog(token, org, project, runId, logId) {
  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/build/builds/${runId}/logs/${logId}?api-version=7.0`,
    { headers: azureHeaders(token) },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Log ${logId} chưa sẵn sàng: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return response.text();
}

async function azureFetch(token, org, project, path, version) {
  const projectSegment = project ? `${encodeURIComponent(project)}/` : "";
  const response = await fetch(
    `https://dev.azure.com/${encodeURIComponent(org)}/${projectSegment}${path}?api-version=${version}`,
    { headers: azureHeaders(token) },
  );
  if (response.status === 401) throw new Error("Azure DevOps PAT is invalid or expired (HTTP 401)");
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps API error: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return response.json();
}

function azureHeaders(token) {
  return {
    Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export function requireAzure(token, org) {
  const resolvedToken = token || process.env.AZURE_DEVOPS_TOKEN || process.env.AZURECLI_TOKEN;
  if (!resolvedToken) {
    throw new Error("Azure DevOps PAT is required (--token, AZURE_DEVOPS_TOKEN or AZURECLI_TOKEN)");
  }
  const resolvedOrg = org || process.env.AZURECLI_ORG || process.env.AZURE_ORG;
  if (!resolvedOrg) throw new Error("Azure organization is required (--org, AZURECLI_ORG or AZURE_ORG)");
  return { token: resolvedToken, org: resolvedOrg };
}

export async function pickProject(token, org) {
  const projects = await listProjects(token, org);
  if (projects.length === 0) throw new Error("Không có project nào trong organization");
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn project",
    choices: projects.map((project) => ({ title: project.name, value: project.name })),
    limit: 15,
  });
  return value;
}

export async function pickPipeline(token, org, project) {
  const pipelines = await listPipelines(token, org, project);
  if (pipelines.length === 0) throw new Error(`Không có pipeline nào trong ${project}`);
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn pipeline",
    choices: pipelines.map((pipeline) => ({ title: pipeline.name, value: pipeline })),
    limit: 15,
  });
  return value;
}

export async function pickRun(azure, project, pipelineId, title = "Chọn run") {
  const runs = await listRuns(azure.token, azure.org, project, pipelineId);
  if (runs.length === 0) throw new Error("Không có run nào");
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: title,
    choices: runs.map((run) => ({
      title: `${run.name} [${run.state}${run.result ? ` ${run.result}` : ""}]`,
      value: run,
    })),
    limit: 15,
  });
  return value;
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--token") {
      index += 1;
      options.token = args[index];
    } else if (arg === "--org") {
      index += 1;
      options.org = args[index];
    } else if (arg === "--project") {
      index += 1;
      options.project = args[index];
    } else if (arg === "--pipeline") {
      index += 1;
      options.pipeline = args[index];
    } else if (arg === "--branch") {
      index += 1;
      options.branch = args[index];
    } else if (arg === "--variables") {
      index += 1;
      options.variables = args[index];
    } else if (arg === "--state") {
      index += 1;
      options.state = args[index];
    } else if (arg === "--task") {
      index += 1;
      options.task = args[index];
    } else if (arg === "--follow") {
      options.follow = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const { token, org } = requireAzure(options.token, options.org);
  const isTty = Boolean(process.stdin.isTTY);

  switch (command) {
    case "list-projects": {
      const projects = await listProjects(token, org);
      projects.forEach((project) => console.log(`${project.name}\t(${project.id})`));
      console.log(`(${projects.length} project trong ${org})`);
      break;
    }
    case "list-repos": {
      const project = options.project || positional[0] || (isTty ? await pickProject(token, org) : null);
      if (!project) throw new Error("PROJECT is required (--project or first arg)");
      const repos = await listRepos(token, org, project);
      repos.forEach((repo) => console.log(repo.name));
      console.log(`(${repos.length} repo trong ${project})`);
      break;
    }
    case "list-pipelines": {
      const project = options.project || positional[0] || (isTty ? await pickProject(token, org) : null);
      if (!project) throw new Error("PROJECT is required (--project or first arg)");
      const pipelines = await listPipelines(token, org, project);
      pipelines.forEach((pipeline) => console.log(`${pipeline.id}\t${pipeline.name}\t${pipeline.folder}`));
      console.log(`(${pipelines.length} pipeline trong ${project})`);
      break;
    }
    case "run": {
      const project = options.project || positional[0] || (isTty ? await pickProject(token, org) : null);
      if (!project) throw new Error("PROJECT is required (--project or first arg)");
      const pipeline = options.pipeline
        ? { id: options.pipeline }
        : isTty
          ? await pickPipeline(token, org, project)
          : null;
      if (!pipeline) throw new Error("--pipeline is required (pipeline id)");
      const branch = options.branch || "main";
      const variables = parsePairs(options.variables);
      const run = await runPipeline(token, org, project, pipeline.id, branch, variables);
      console.log(`Started run ${run.id} (${run.name}) cho pipeline ${pipeline.id} trong ${project}@${branch}`);
      break;
    }
    case "list-runs": {
      const project = options.project || positional[0] || (isTty ? await pickProject(token, org) : null);
      if (!project) throw new Error("PROJECT is required (--project or first arg)");
      const pipelineId = options.pipeline || positional[1];
      if (!pipelineId) throw new Error("PIPELINE_ID is required (--pipeline or second arg)");
      const runs = (await listRuns(token, org, project, pipelineId))
        .filter((run) => !options.state || run.state === options.state);
      runs.forEach((run) =>
        console.log(`${run.id}\t${run.name}\t${run.state}\t${run.result}\t${run.createdDate}`),
      );
      console.log(`(${runs.length} run của pipeline ${pipelineId} trong ${project})`);
      break;
    }
    case "stop": {
      const project = options.project || positional[0];
      const pipelineId = options.pipeline || positional[1];
      const runId = positional[2];
      if (!project || !pipelineId || !runId) {
        throw new Error("Usage: azure-pipelines.mjs stop PROJECT PIPELINE_ID RUN_ID");
      }
      await stopRun(token, org, project, pipelineId, runId);
      console.log(`Cancelled run ${runId} (pipeline ${pipelineId}, ${project})`);
      break;
    }
    case "log": {
      const project = options.project || positional[0];
      const pipelineId = options.pipeline || positional[1];
      const runId = options.runId || positional[2];
      if (!project || !pipelineId || !runId) {
        throw new Error("Usage: azure-pipelines.mjs log PROJECT PIPELINE_ID RUN_ID [--follow] [--task NAME]");
      }
      if (options.follow) {
        let previous = "";
        for (;;) {
          const { state, result } = await fetchRunState(token, org, project, pipelineId, runId);
          const line = `${state}${result ? ` ${result}` : ""}`;
          if (line !== previous) {
            console.log(`Run ${runId}: ${line}`);
            previous = line;
          }
          if (state === "completed" || state === "cancelled") break;
          await sleep(10_000);
        }
        break;
      }
      const records = await timelineRecords(token, org, project, runId);
      if (records.length === 0) throw new Error("Chưa có task log nào cho run này");
      const task = options.task
        ? records.find((record) => record.name === options.task || record.logId === Number(options.task))
        : isTty
          ? (await pickTask(records)).value
          : null;
      if (!task) throw new Error("--task is required when --follow is not used (task name hoặc log id)");
      const log = await fetchTaskLog(token, org, project, runId, task.logId);
      console.log(log);
      break;
    }
    default:
      console.log("Usage: node deploy-cli/azure-pipelines.mjs <command> [args]");
      console.log("Commands:");
      console.log("  list-projects");
      console.log("  list-repos PROJECT | --project PROJECT");
      console.log("  list-pipelines PROJECT | --project PROJECT");
      console.log("  run PROJECT PIPELINE_ID [--branch main] [--variables k=v,...]");
      console.log("  list-runs PROJECT PIPELINE_ID");
      console.log("  stop PROJECT PIPELINE_ID RUN_ID");
      console.log("  log PROJECT PIPELINE_ID RUN_ID [--follow] [--task NAME]");
      console.log("Options: --org, --token");
      process.exit(2);
  }
}

async function pickTask(records) {
  return prompts({
    type: "select",
    name: "value",
    message: "Chọn task",
    choices: records.map((record) => ({
      title: `${record.name} [${record.state} ${record.result}]`,
      value: record,
    })),
    limit: 15,
  });
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

if (process.argv[1]?.endsWith("azure-pipelines.mjs")) {
  runCli().catch((error) => {
    console.error(`azure-pipelines: ${error.message}`);
    process.exit(1);
  });
}