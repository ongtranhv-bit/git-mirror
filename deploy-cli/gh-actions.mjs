#!/usr/bin/env node
import prompts from "prompts";
import { resolveWorkflow } from "./gh-lib.mjs";

export async function listRepos(token, filter = "") {
  const url = `https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated`;
  const repos = await ghFetch(token, url);
  return repos
    .map((repo) => repo.full_name)
    .filter((name) => !filter || name.toLowerCase().includes(filter.toLowerCase()));
}

export async function listWorkflows(token, repo) {
  const { workflows } = await ghFetch(token, `https://api.github.com/repos/${repo}/actions/workflows`);
  return workflows
    .filter((workflow) => workflow.state === "active")
    .map((workflow) => ({ id: workflow.id, name: workflow.name, path: workflow.path }));
}

export async function runWorkflow(token, repo, workflowRef, ref, inputs) {
  const workflow = await resolveWorkflow(token, repo, workflowRef);
  const response = await ghFetch(token, `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs: inputs ?? {} }),
  });
  if (response.status === 204) return { ok: true, workflow };
  const body = await response.text();
  throw new Error(`GitHub Actions dispatch failed: HTTP ${response.status} ${body}`);
}

export async function listRuns(token, repo, workflowRef, status) {
  const workflow = workflowRef ? await resolveWorkflow(token, repo, workflowRef) : null;
  const query = new URLSearchParams({ per_page: "20" });
  if (workflow) query.set("workflow_id", String(workflow));
  if (status) query.set("status", status);
  const { workflow_runs: runs } = await ghFetch(
    token,
    `https://api.github.com/repos/${repo}/actions/runs?${query.toString()}`,
  );
  return runs.map((run) => ({
    id: run.id,
    number: run.run_number,
    event: run.event,
    branch: run.head_branch,
    sha: run.head_sha.slice(0, 8),
    status: run.status,
    conclusion: run.conclusion ?? "",
    createdAt: run.created_at,
  }));
}

export async function stopRun(token, repo, runId) {
  const response = await ghFetch(token, `https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
    method: "POST",
  });
  if (response.status !== 202) {
    const body = await response.text();
    throw new Error(`Cannot cancel run ${runId}: HTTP ${response.status} ${body}`);
  }
  return { ok: true };
}

export async function fetchRunStatus(token, repo, runId) {
  const run = await ghFetch(token, `https://api.github.com/repos/${repo}/actions/runs/${runId}`);
  return { status: run.status, conclusion: run.conclusion ?? "" };
}

export async function listJobs(token, repo, runId) {
  const { jobs } = await ghFetch(token, `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`);
  return jobs.map((job) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion ?? "" }));
}

export async function fetchJobLog(token, repo, jobId) {
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "git-mirror-deploy-cli",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Log for job ${jobId} is not available yet: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.text();
}

async function ghFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "git-mirror-deploy-cli",
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) throw new Error("GitHub token is invalid or expired (HTTP 401)");
  if (response.status === 404) throw new Error(`Not found on GitHub (HTTP 404): ${url}`);
  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub API error: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  return response.status === 204 ? response : response.json();
}

export function requireToken(token) {
  const resolved = token || process.env.GH_TOKEN || process.env.GHCLI_TOKEN || process.env.GITHUB_TOKEN;
  if (!resolved) throw new Error("GitHub token is required (--token, GH_TOKEN or GHCLI_TOKEN)");
  return resolved;
}

export async function pickRepo(token, filter) {
  const repos = await listRepos(token, filter);
  if (repos.length === 0) throw new Error("Không tìm thấy repository nào (bạn có quyền truy cập?)");
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn repository",
    choices: repos.map((repo) => ({ title: repo, value: repo })),
    limit: 15,
  });
  return value;
}

export async function pickWorkflow(token, repo) {
  const workflows = await listWorkflows(token, repo);
  if (workflows.length === 0) throw new Error(`Không có workflow nào trong ${repo}`);
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn workflow",
    choices: workflows.map((workflow) => ({ title: `${workflow.name} (${workflow.path})`, value: workflow })),
    limit: 15,
  });
  return value;
}

export async function pickRun(runs, title = "Chọn run") {
  if (runs.length === 0) throw new Error("Không có run nào");
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: title,
    choices: runs.map((run) => ({
      title: `#${run.number} ${run.event} ${run.branch} ${run.sha} [${run.status}${run.conclusion ? ` ${run.conclusion}` : ""}]`,
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
    } else if (arg === "--repo") {
      index += 1;
      options.repo = args[index];
    } else if (arg === "--workflow") {
      index += 1;
      options.workflow = args[index];
    } else if (arg === "--ref") {
      index += 1;
      options.ref = args[index];
    } else if (arg === "--status") {
      index += 1;
      options.status = args[index];
    } else if (arg === "--filter") {
      index += 1;
      options.filter = args[index];
    } else if (arg === "--job") {
      index += 1;
      options.job = args[index];
    } else if (arg === "--inputs") {
      index += 1;
      options.inputs = args[index];
    } else if (arg === "--follow") {
      options.follow = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const token = requireToken(options.token);
  const isTty = Boolean(process.stdin.isTTY);

  switch (command) {
    case "list-repos": {
      const repos = await listRepos(token, options.filter);
      repos.forEach((repo) => console.log(repo));
      console.log(`(${repos.length} repo)`);
      break;
    }
    case "list-workflows": {
      const repo = options.repo || positional[0] || (isTty ? await pickRepo(token) : null);
      if (!repo) throw new Error("REPO is required (--repo or first arg)");
      const workflows = await listWorkflows(token, repo);
      workflows.forEach((workflow) => console.log(`${workflow.id}\t${workflow.name}\t${workflow.path}`));
      console.log(`(${workflows.length} workflow trong ${repo})`);
      break;
    }
    case "run": {
      const repo = options.repo || positional[0] || (isTty ? await pickRepo(token) : null);
      if (!repo) throw new Error("REPO is required (--repo or first arg)");
      const workflowRef = options.workflow || (isTty ? (await pickWorkflow(token, repo)).path : null);
      if (!workflowRef) throw new Error("--workflow is required (file path or id)");
      const ref = options.ref || "main";
      const inputs = parsePairs(options.inputs);
      const result = await runWorkflow(token, repo, workflowRef, ref, inputs);
      console.log(`Dispatched workflow ${result.workflow} on ${repo}@${ref}${Object.keys(inputs).length ? ` inputs=${JSON.stringify(inputs)}` : ""}`);
      break;
    }
    case "list-runs": {
      const repo = options.repo || positional[0] || (isTty ? await pickRepo(token) : null);
      if (!repo) throw new Error("REPO is required (--repo or first arg)");
      const runs = await listRuns(token, repo, options.workflow, options.status);
      runs.forEach((run) =>
        console.log(`#${run.number}\t${run.id}\t${run.event}\t${run.branch}\t${run.sha}\t${run.status}\t${run.conclusion}\t${run.createdAt}`),
      );
      console.log(`(${runs.length} run trong ${repo})`);
      break;
    }
    case "stop": {
      const repo = options.repo || positional[0];
      const runId = options.runId || positional[1];
      if (!repo || !runId) throw new Error("Usage: gh-actions.mjs stop REPO RUN_ID");
      await stopRun(token, repo, runId);
      console.log(`Cancelled run ${runId} in ${repo}`);
      break;
    }
    case "log": {
      const repo = options.repo || positional[0];
      const runId = options.runId || positional[1];
      if (!repo || !runId) throw new Error("Usage: gh-actions.mjs log REPO RUN_ID [--follow] [--job ID]");
      if (options.follow) {
        let previous = "";
        for (;;) {
          const { status, conclusion } = await fetchRunStatus(token, repo, runId);
          const line = `${status}${conclusion ? ` ${conclusion}` : ""}`;
          if (line !== previous) {
            console.log(`Run ${runId}: ${line}`);
            previous = line;
          }
          if (status === "completed") break;
          await sleep(10_000);
        }
        break;
      }
      const jobs = await listJobs(token, repo, runId);
      const jobId = options.job || (jobs.length === 1 ? jobs[0].id : isTty ? (await pickJob(jobs)).id : null);
      if (!jobId) throw new Error("--job is required when a run has multiple jobs");
      const log = await fetchJobLog(token, repo, jobId);
      console.log(log);
      break;
    }
    default:
      console.log("Usage: node deploy-cli/gh-actions.mjs <command> [args]");
      console.log("Commands:");
      console.log("  list-repos [--filter TEXT]");
      console.log("  list-workflows REPO | --repo REPO");
      console.log("  run REPO --workflow FILE|ID [--ref main] [--inputs k=v,...]");
      console.log("  list-runs REPO [--workflow FILE|ID] [--status STATUS]");
      console.log("  stop REPO RUN_ID");
      console.log("  log REPO RUN_ID [--follow] [--job JOB_ID]");
      console.log("Options: --token, --repo");
      process.exit(2);
  }
}

async function pickJob(jobs) {
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Chọn job",
    choices: jobs.map((job) => ({ title: `${job.name} [${job.status} ${job.conclusion}]`, value: job })),
    limit: 15,
  });
  return value;
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

if (process.argv[1]?.endsWith("gh-actions.mjs")) {
  runCli().catch((error) => {
    console.error(`gh-actions: ${error.message}`);
    process.exit(1);
  });
}