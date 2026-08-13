import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(root, 'deploy-cli', '.env'), 'utf8');
const controls = new Map();
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (match) controls.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
}
const token = controls.get('AZURECLI_TOKEN');
const org = controls.get('AZURECLI_ORG');
const project = controls.get('AZURECLI_PROJECT');
if (!token || !org || !project) {
  console.error('deploy-cli/.env needs AZURECLI_TOKEN, AZURECLI_ORG, AZURECLI_PROJECT (run prepare-azure-env.mjs first)');
  process.exit(1);
}

const api = `https://dev.azure.com/${org}/${project}/_apis`;
const orgApi = `https://dev.azure.com/${org}/_apis`;
const headers = {
  Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
  'Content-Type': 'application/json',
};
async function apiCall(path, init = {}) {
  const response = await fetch(`${api}/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}
async function orgApiCall(path, init = {}) {
  const response = await fetch(`${orgApi}/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

const projectCheck = await orgApiCall(`projects/${encodeURIComponent(project)}?api-version=7.1-preview`);
console.log(`project "${project}" found in org "${org}" (id ${projectCheck.id})`);

let repo;
try {
  repo = await apiCall(`git/repositories/git-mirror?api-version=7.1-preview`);
  console.log(`repo git-mirror already exists (id ${repo.id})`);
} catch (error) {
  if (!String(error.message).includes('404')) throw error;
  repo = await apiCall(`git/repositories?api-version=7.1-preview`, {
    method: 'POST',
    body: JSON.stringify({ name: 'git-mirror' }),
  });
  console.log(`created repo git-mirror (id ${repo.id})`);
}

const pushUrl = `https://oauth2:${token}@dev.azure.com/${org}/${project}/_git/git-mirror`;
const current = spawnSync('git', ['remote', 'get-url', 'azure'], { encoding: 'utf8' });
if (current.status !== 0) {
  spawnSync('git', ['remote', 'add', 'azure', pushUrl], { stdio: 'inherit' });
} else {
  spawnSync('git', ['remote', 'set-url', 'azure', pushUrl], { stdio: 'inherit' });
}
const pushed = spawnSync('git', ['push', 'azure', 'main:main', '--force'], { stdio: 'inherit' });
if (pushed.status !== 0) process.exit(pushed.status ?? 1);
console.log('pushed main to Azure repo git-mirror');

let pipeline;
try {
  pipeline = await apiCall(`pipelines/git-mirror?api-version=7.1-preview`);
  console.log(`pipeline git-mirror already exists (id ${pipeline.id})`);
} catch (error) {
  if (!String(error.message).includes('404')) throw error;
  pipeline = await apiCall(`pipelines?api-version=7.1-preview`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'git-mirror',
      configuration: {
        type: 'yaml',
        path: '.azure/azure-pipelines.yml',
        repository: { id: repo.id, name: 'git-mirror', type: 'azureReposGit' },
      },
    }),
  });
  console.log(`created pipeline git-mirror (id ${pipeline.id})`);
}

console.log(`\nnext: node deploy-cli/azurecli.mjs deploy-cli/.env  (set variable group secrets)`);
console.log(`then:  node deploy-cli/azure-pipelines.mjs run --org "${org}" --project "${project}" --pipeline git-mirror`);