import { spawnSync } from 'node:child_process';
let result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
result = spawnSync(process.execPath, ['dist/cli.js', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
