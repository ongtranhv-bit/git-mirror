import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLogger } from '../../src/shared/logger.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { listenPendingEvents, type EventPaths } from '../../src/rtdb/events.js';
import { startHeartbeat } from '../../src/rtdb/instances.js';
import { processHookEvent } from '../../src/sync/router.js';
import type { HookEvent, SyncEventResult } from '../../src/types.js';
import {
  FakeProvider,
  baseConfig,
  commitFiles,
  createBareRepo,
  createSourceRepo,
  destination,
  fileUrl,
  git,
  hook,
  tempDirectory,
} from '../helpers.js';

const ROUNDS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error('waitFor timed out');
}

test(`two parallel workers sync commits in order across ${ROUNDS} rounds`, async () => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const root = await tempDirectory(`parallel-round-${round}-`);
    const source = await createSourceRepo(root, 'app', { 'app.txt': `v0 round ${round}` });
    const sourceB = await createSourceRepo(root, 'appb', { 'appb.txt': `v0b round ${round}` });
    const shas = [source.sha];
    for (let index = 1; index <= 3; index += 1) {
      shas.push(await commitFiles(source.path, { 'app.txt': `v${index} round ${round}` }, `commit ${index} round ${round}`));
    }

    const bareDestination = await createBareRepo(root, 'mirror-app');
    const bareDestinationB = await createBareRepo(root, 'mirror-appb');
    const config = baseConfig(resolve(root, 'cache'), {
      mirror: destination('one-to-one', '{sourceRepo}'),
      mirrorb: destination('one-to-one', '{sourceRepo}'),
    });
    const adapter = new FakeProvider('mirror', config.dest.mirror!, fileUrl(bareDestination));
    const adapterB = new FakeProvider('mirrorb', config.dest.mirrorb!, fileUrl(bareDestinationB));
    const client = new MemoryRtdbClient();
    const paths = config.rtdb as EventPaths;

    const optionsFor = (instanceId: string) => ({
      client,
      paths,
      instanceId,
      lockTtlSeconds: 60,
      maxEventRetries: 8,
      logger: createLogger('error'),
      handler: (event: HookEvent) =>
        processHookEvent({
          config,
          hook: event,
          instanceId,
          logger: createLogger('error'),
          rtdb: client,
          adapters: { mirror: adapter, mirrorb: adapterB },
        }),
    });

    const worker1 = listenPendingEvents(optionsFor('worker-1'));
    const worker2 = listenPendingEvents(optionsFor('worker-2'));
    const stopHeartbeat1 = await startHeartbeat(client, paths.instancesPath, 'worker-1', 5, () => undefined);
    const stopHeartbeat2 = await startHeartbeat(client, paths.instancesPath, 'worker-2', 5, () => undefined);

    try {
      for (const [index, sha] of shas.entries()) {
        const event = hook(source.path, 'app', sha, `evt-${round}-${index}`);
        await client.set(`${paths.pendingPath}/evt-${round}-${index}`, {
          ...event,
          targetDestinations: ['mirror'],
          receivedAt: Date.now() + index,
        });
      }
      await client.set(`${paths.pendingPath}/evt-${round}-b`, {
        ...hook(sourceB.path, 'appb', sourceB.sha, `evt-${round}-b`),
        targetDestinations: ['mirrorb'],
        receivedAt: Date.now() + shas.length,
      });
      await sleep(1500);

      await waitFor(async () => {
        const pending = await client.get(`${paths.pendingPath}`);
        const processing = await client.get(`${paths.processingPath}`);
        return Object.keys(pending ?? {}).length === 0 && Object.keys(processing ?? {}).length === 0;
      });

      const processed = (await client.get<Record<string, SyncEventResult>>(paths.processedPath)) ?? {};
      assert.equal(Object.keys(processed).length, shas.length + 1);
      for (const [index, sha] of shas.entries()) {
        const result = processed[`evt-${round}-${index}`];
        assert.ok(result, `processed entry evt-${round}-${index} missing`);
        assert.equal(result.sourceSha, sha);
        assert.equal(result.destinations[0]?.status, 'synced');
      }
      const resultB = processed[`evt-${round}-b`];
      assert.ok(resultB, 'processed entry for appb missing');
      assert.equal(resultB.destinations[0]?.status, 'synced');

      const markers = (await client.get<Record<string, { eventId: string }>>(paths.processedByCommitPath)) ?? {};
      assert.equal(Object.keys(markers).length, shas.length + 1);

      const failed = (await client.get(`${paths.failedPath}`)) ?? {};
      assert.equal(Object.keys(failed).length, 0);

      assert.equal(await git(bareDestination, ['rev-parse', 'refs/heads/main']), shas[shas.length - 1]);
      const count = Number(await git(bareDestination, ['rev-list', '--count', 'refs/heads/main']));
      assert.equal(count, shas.length);
      assert.equal(await git(bareDestinationB, ['rev-parse', 'refs/heads/main']), sourceB.sha);
    } finally {
      await stopHeartbeat1();
      await stopHeartbeat2();
      worker1.stop();
      worker2.stop();
    }
  }
});

test('duplicate delivery of an already processed commit is skipped', async () => {
  const root = await tempDirectory('parallel-dedup-');
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'dedup' });
  const bareDestination = await createBareRepo(root, 'mirror-app');
  const config = baseConfig(resolve(root, 'cache'), { mirror: destination('one-to-one') });
  const adapter = new FakeProvider('mirror', config.dest.mirror!, fileUrl(bareDestination));
  const client = new MemoryRtdbClient();
  const paths = config.rtdb as EventPaths;

  const optionsFor = (instanceId: string) => ({
    client,
    paths,
    instanceId,
    lockTtlSeconds: 60,
    maxEventRetries: 8,
    logger: createLogger('error'),
    handler: (event: HookEvent) =>
      processHookEvent({ config, hook: event, instanceId, logger: createLogger('error'), rtdb: client, adapters: { mirror: adapter } }),
  });

  const worker1 = listenPendingEvents(optionsFor('worker-1'));
  const worker2 = listenPendingEvents(optionsFor('worker-2'));
  const stopHeartbeat1 = await startHeartbeat(client, paths.instancesPath, 'worker-1', 5, () => undefined);
  const stopHeartbeat2 = await startHeartbeat(client, paths.instancesPath, 'worker-2', 5, () => undefined);

  try {
    await client.set(`${paths.pendingPath}/evt-dup-a`, { ...hook(source.path, 'app', source.sha, 'evt-dup-a'), receivedAt: Date.now() });
    await sleep(150);
    await client.set(`${paths.pendingPath}/evt-dup-b`, { ...hook(source.path, 'app', source.sha, 'evt-dup-b'), receivedAt: Date.now() + 1 });
    await sleep(500);

    await waitFor(async () => {
      const pending = await client.get(`${paths.pendingPath}`);
      const processing = await client.get(`${paths.processingPath}`);
      return Object.keys(pending ?? {}).length === 0 && Object.keys(processing ?? {}).length === 0;
    });

    const processed = (await client.get<Record<string, SyncEventResult>>(paths.processedPath)) ?? {};
    assert.equal(Object.keys(processed).length, 1);
    assert.equal(processed['evt-dup-a']?.destinations[0]?.status, 'synced');
    assert.equal(await client.get(`${paths.processedPath}/evt-dup-b`), null);

    const markers = (await client.get<Record<string, unknown>>(paths.processedByCommitPath)) ?? {};
    assert.equal(Object.keys(markers).length, 1);
    assert.equal(await git(bareDestination, ['rev-parse', 'refs/heads/main']), source.sha);
  } finally {
    await stopHeartbeat1();
    await stopHeartbeat2();
    worker1.stop();
    worker2.stop();
  }
});