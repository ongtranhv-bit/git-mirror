import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeOnce } from '../../src/webhook/github-bridge.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import { baseConfig } from '../helpers.js';
import type { AppConfig } from '../../src/types.js';

const WEBHOOK_PATH = '/github-noti';

function pushPayload(fullName: string, after: string, message: string): Record<string, unknown> {
  const name = fullName.split('/').at(-1);
  return {
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after,
    repository: { name, full_name: fullName, clone_url: `https://github.com/${fullName}.git` },
    head_commit: { id: after, message },
    commits: [{ id: after, message }],
  };
}

function optionsFor(client: MemoryRtdbClient, config: AppConfig) {
  return { client, config, logger: createLogger('error'), webhookPath: WEBHOOK_PATH };
}

test('bridge processes a delivery, queues the event, and removes the delivery key', async () => {
  const client = new MemoryRtdbClient();
  const config = baseConfig('/tmp/test', {});
  const key = 'k1';
  await client.set(`${WEBHOOK_PATH}/${key}`, pushPayload('org/app', 'a'.repeat(40), 'feat: ok'));
  const result = await bridgeOnce(optionsFor(client, config));
  assert.equal(result.processed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(await client.get(`${WEBHOOK_PATH}/${key}`), null);
  const pending = await client.get<Record<string, unknown>>(config.rtdb.pendingPath);
  assert.ok(pending);
  assert.equal(Object.keys(pending).length, 1);
});

test('bridge removes an already-claimed delivery without re-processing it', async () => {
  const client = new MemoryRtdbClient();
  const config = baseConfig('/tmp/test', {});
  const key = 'claimed';
  await client.set(`${WEBHOOK_PATH}/${key}`, {
    ...pushPayload('org/app', 'b'.repeat(40), 'feat: old'),
    _bridge: { consumedAt: Date.now() },
  });
  const result = await bridgeOnce(optionsFor(client, config));
  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(await client.get(`${WEBHOOK_PATH}/${key}`), null);
  assert.equal(await client.get(config.rtdb.pendingPath), null);
});

test('bridge skips deliveries excluded by the commit filter and removes the key', async () => {
  const client = new MemoryRtdbClient();
  const config = baseConfig('/tmp/test', {});
  config.src.filter = { commit: { exclude: [{ mode: 'prefix', value: 'Debug' }] } };
  const key = 'filtered';
  await client.set(`${WEBHOOK_PATH}/${key}`, pushPayload('org/app', 'c'.repeat(40), 'Debug: ignore me'));
  const result = await bridgeOnce(optionsFor(client, config));
  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(await client.get(`${WEBHOOK_PATH}/${key}`), null);
  assert.equal(await client.get(config.rtdb.pendingPath), null);
});

test('bridge applies repo filters to repository.name, not repository.full_name', async () => {
  const client = new MemoryRtdbClient();
  const config = baseConfig('/tmp/test', {});
  config.src.filter = { repo: { exclude: [{ mode: 'prefix', value: 'org' }] } };
  await client.set(`${WEBHOOK_PATH}/owner-must-not-match`, pushPayload('org/application', 'd'.repeat(40), 'feat: ok'));
  const firstResult = await bridgeOnce(optionsFor(client, config));
  assert.equal(firstResult.processed, 1);
  assert.equal(firstResult.skipped, 0);

  config.src.filter = { repo: { exclude: [{ mode: 'prefix', value: 'app' }] } };
  await client.set(`${WEBHOOK_PATH}/repo-must-match`, pushPayload('other/application', 'e'.repeat(40), 'feat: ok'));
  const secondResult = await bridgeOnce(optionsFor(client, config));
  assert.equal(secondResult.processed, 0);
  assert.equal(secondResult.skipped, 1);
  assert.equal(await client.get(`${WEBHOOK_PATH}/repo-must-match`), null);
});
