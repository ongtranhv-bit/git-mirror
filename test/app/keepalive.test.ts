import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeepaliveGuards, startCodespaceKeepalive } from '../../src/app/keepalive.js';
import { createLogger } from '../../src/shared/logger.js';

function baseConfig(): { enabled: boolean; intervalMinutes: number } {
  return { enabled: true, intervalMinutes: 1 };
}

test('evaluateKeepaliveGuards requires codespace env, name, and gh CLI', () => {
  assert.equal(evaluateKeepaliveGuards({}, true).ok, false);
  assert.match(evaluateKeepaliveGuards({ CODESPACES: 'true' }, true).reason ?? '', /CODESPACE_NAME/);
  assert.match(
    evaluateKeepaliveGuards({ CODESPACES: 'true', CODESPACE_NAME: 'abc' }, false).reason ?? '',
    /gh CLI/,
  );
  assert.equal(evaluateKeepaliveGuards({ CODESPACES: 'true', CODESPACE_NAME: 'abc' }, true).ok, true);
});

test('disabled keepalive does not ping', () => {
  let pings = 0;
  const handle = startCodespaceKeepalive({
    config: { ...baseConfig(), enabled: false },
    logger: createLogger('error'),
    deps: {
      env: { CODESPACES: 'true', CODESPACE_NAME: 'abc' },
      ghAvailable: () => true,
      ping: () => {
        pings += 1;
        return { status: 0, stderr: '', durationMs: 1 };
      },
    },
  });
  assert.equal(handle.started, false);
  assert.equal(handle.reason, 'disabled');
  assert.equal(pings, 0);
});

test('missing codespace environment warns and does not ping', () => {
  let pings = 0;
  const handle = startCodespaceKeepalive({
    config: baseConfig(),
    logger: createLogger('error'),
    deps: {
      env: { CODESPACES: 'false' },
      ghAvailable: () => true,
      ping: () => {
        pings += 1;
        return { status: 0, stderr: '', durationMs: 1 };
      },
    },
  });
  assert.equal(handle.started, false);
  assert.match(handle.reason ?? '', /CODESPACES/);
  assert.equal(pings, 0);
});

test('missing gh CLI warns and does not ping', () => {
  let pings = 0;
  const handle = startCodespaceKeepalive({
    config: baseConfig(),
    logger: createLogger('error'),
    deps: {
      env: { CODESPACES: 'true', CODESPACE_NAME: 'abc' },
      ghAvailable: () => false,
      ping: () => {
        pings += 1;
        return { status: 0, stderr: '', durationMs: 1 };
      },
    },
  });
  assert.equal(handle.started, false);
  assert.match(handle.reason ?? '', /gh CLI/);
  assert.equal(pings, 0);
});

test('keepalive pings immediately when guards pass and stop clears the timer', async () => {
  const pings: string[] = [];
  const handle = startCodespaceKeepalive({
    config: { ...baseConfig(), intervalMinutes: 0.02 },
    logger: createLogger('error'),
    deps: {
      env: { CODESPACES: 'true', CODESPACE_NAME: 'my-codespace' },
      ghAvailable: () => true,
      ping: (name) => {
        pings.push(name);
        return { status: 0, stderr: '', durationMs: 1 };
      },
    },
  });
  assert.equal(handle.started, true);
  assert.equal(pings.length, 1);
  assert.equal(pings[0], 'my-codespace');
  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.stop();
  const afterStop = pings.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(pings.length, afterStop);
});

test('failed ping logs a warning but keeps the loop running', async () => {
  const results = [
    { status: 1, stderr: 'boom', durationMs: 5 },
    { status: 0, stderr: '', durationMs: 2 },
  ];
  const handle = startCodespaceKeepalive({
    config: { ...baseConfig(), intervalMinutes: 0.02 },
    logger: createLogger('error'),
    deps: {
      env: { CODESPACES: 'true', CODESPACE_NAME: 'abc' },
      ghAvailable: () => true,
      ping: () => results.shift() ?? { status: 0, stderr: '', durationMs: 1 },
    },
  });
  assert.equal(handle.started, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.stop();
});
