import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../src/shared/exec.js';

const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const helper = 'scripts/codespace-runtime-env.sh';

function allDailyTokens(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODESPACE_ROTATION_TIMEZONE: 'UTC' };
  for (let day = 1; day <= 31; day += 1) env[`GH_SOURCE_TOKEN_DAY_${String(day).padStart(2, '0')}`] = `token-${day}`;
  return env;
}

test('Codespace runtime env exposes only current token alias to child process', async () => {
  const result = await runCommand(bash, ['-c', `source "${helper}"; printf '%s|%s|%s' "$GH_SOURCE_TOKEN_CURRENT" "\${GH_SOURCE_TOKEN_DAY_07-unset}" "\${GH_SOURCE_TOKEN_DAY_08-unset}"`], {
    env: allDailyTokens(),
    timeoutMs: 5_000,
  });
  assert.match(result.stdout, /^token-\d+\|unset\|unset$/);
});

test('Codespace runtime env fails closed when current day secret is missing', async () => {
  const result = await runCommand(bash, ['-c', `source "${helper}"`], {
    env: { ...process.env, CODESPACE_ROTATION_TIMEZONE: 'UTC' },
    timeoutMs: 5_000,
    allowFailure: true,
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /missing required secret name GH_SOURCE_TOKEN_DAY_/);
});
