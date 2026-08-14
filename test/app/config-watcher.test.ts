import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import { LiveConfig } from '../../src/config/live.js';
import { encodeConfig } from '../../src/config/load.js';
import { watchConfigReload } from '../../src/app/config-watcher.js';
import { baseConfig, destination, tempDirectory } from '../helpers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const root = await tempDirectory('config-watcher-');
  const configA = baseConfig(resolve(root, 'cache'), { mirror: destination('one-to-one') });
  const client = new MemoryRtdbClient();
  const live = new LiveConfig(configA);
  return { root, configA, client, live };
}

test('valid RTDB config change is applied live without restart', async () => {
  const { configA, client, live } = await setup();
  const configB = { ...configA, runtime: { ...configA.runtime, logLevel: 'debug' as const } };
  await client.set('/sync/config', encodeConfig(JSON.stringify(configB)));

  let applied = 0;
  let restartReasons: string[] = [];
  const handle = watchConfigReload({
    client,
    rtdbPath: '/sync/config',
    live,
    logger: createLogger('error'),
    onApplied: () => { applied += 1; },
    onRestartRequired: (reason) => { restartReasons.push(reason); },
  });
  await sleep(50);

  assert.equal(restartReasons.length, 0);
  assert.equal(applied, 1);
  assert.equal(live.get().runtime.logLevel, 'debug');
  handle.stop();
});

test('config change requiring restart is rejected and old config stays active', async () => {
  const { configA, client, live } = await setup();
  const configB = { ...configA, runtime: { ...configA.runtime, workdir: '/other/workdir' } };
  await client.set('/sync/config', encodeConfig(JSON.stringify(configB)));

  let applied = 0;
  let restartReasons: string[] = [];
  const handle = watchConfigReload({
    client,
    rtdbPath: '/sync/config',
    live,
    logger: createLogger('error'),
    onApplied: () => { applied += 1; },
    onRestartRequired: (reason) => { restartReasons.push(reason); },
  });
  await sleep(50);

  assert.equal(applied, 0);
  assert.equal(restartReasons.length, 1);
  assert.match(restartReasons[0] ?? '', /runtime\.workdir/);
  assert.equal(live.get().runtime.workdir, configA.runtime.workdir);
  handle.stop();
});

test('invalid RTDB config is rejected, error recorded, old config stays active', async () => {
  const { configA, client, live } = await setup();
  await client.set('/sync/config', 'not-base64-json');

  let applied = 0;
  let rejected = 0;
  const handle = watchConfigReload({
    client,
    rtdbPath: '/sync/config',
    live,
    logger: createLogger('error'),
    errorPath: '/sync/state/config-errors',
    onApplied: () => { applied += 1; },
    onRejected: () => { rejected += 1; },
  });
  await sleep(50);

  assert.equal(applied, 0);
  assert.equal(rejected, 1);
  const errors = await client.get<Record<string, unknown>>('/sync/state/config-errors');
  assert.ok(errors && Object.keys(errors).length === 1);
  handle.stop();
});

test('disabled watcher ignores RTDB changes', async () => {
  const { configA, client, live } = await setup();
  const configB = { ...configA, runtime: { ...configA.runtime, logLevel: 'debug' as const } };
  await client.set('/sync/config', encodeConfig(JSON.stringify(configB)));

  let applied = 0;
  const handle = watchConfigReload({
    client,
    rtdbPath: '/sync/config',
    live,
    logger: createLogger('error'),
    enabled: false,
    onApplied: () => { applied += 1; },
  });
  await sleep(50);

  assert.equal(applied, 0);
  assert.equal(live.get().runtime.logLevel, configA.runtime.logLevel);
  handle.stop();
});
