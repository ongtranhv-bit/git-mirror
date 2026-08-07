import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
await rm('.test-dist', { recursive: true, force: true });
let result = spawnSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name.endsWith('.test.js')) files.push(path);
  }
}
await collect('.test-dist/test');
const coverage = process.argv.includes('--coverage');
const args = [...(coverage ? ['--experimental-test-coverage'] : []), '--test', ...files];
result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
