import { spawnSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';
const result = spawnSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await chmod('dist/cli.js', 0o755);
