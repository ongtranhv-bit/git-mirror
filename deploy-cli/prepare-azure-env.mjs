import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, 'deploy-cli', '.env');

const sourceEnv = existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8') : '';
const sourceValues = new Map();
for (const line of sourceEnv.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (match) sourceValues.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
}
const value = (name) => process.env[name] ?? sourceValues.get(name) ?? '';

const pat = value('AZCLI_PAT') || value('AZURE_DEVOPS_TOKEN') || value('AZURECLI_TOKEN');
const org = value('AZCLI_ORG') || value('AZURE_DEVOPS_ORG') || value('AZURECLI_ORG');
const project = value('AZCLI_PROJECT') || value('AZURE_DEVOPS_PROJECT') || value('AZURECLI_PROJECT');
const groupName = value('AZCLI_GROUP_NAME') || 'git-mirror';

if (!pat) {
  console.error('set AZCLI_PAT (Azure DevOps PAT: Code Read&Write, Build Read&Execute, Variable Groups Read&Manage)');
  process.exit(1);
}
if (!org) {
  console.error('set AZCLI_ORG (Azure DevOps organization name)');
  process.exit(1);
}
if (!project) {
  console.error('set AZCLI_PROJECT (Azure DevOps project name)');
  process.exit(1);
}

const secret = (name) => value(name) || (() => {
    console.error(`missing secret ${name} (set it in env or .env)`);
    process.exit(1);
  })();

const lines = [
  `AZURECLI_TOKEN=${pat}`,
  `AZURECLI_ORG=${org}`,
  `AZURECLI_PROJECT=${project}`,
  `AZURECLI_GROUP_NAME=${groupName}`,
  '',
  '# azurecli:pipeline-secret',
  `RTDB_URL=${secret('RTDB_URL')}`,
  '# azurecli:pipeline-secret',
  `GOOGLE_SERVICE_ACCOUNT_B64=${secret('GOOGLE_SERVICE_ACCOUNT_B64')}`,
  '# azurecli:pipeline-secret',
  `RTDB_AUTH_SECRET=${secret('RTDB_AUTH_SECRET')}`,
  '',
];

writeFileSync(envFile, lines.join('\n'));
console.log(`wrote ${envFile} for org=${org} project=${project} group=${groupName}`);