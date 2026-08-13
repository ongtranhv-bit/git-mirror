import test from 'node:test';
import assert from 'node:assert/strict';
import { commitKeyOf, processPendingEvent, recoverExpiredJobs, cleanupOldEvents } from '../../src/rtdb/events.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import { AppError } from '../../src/shared/errors.js';
import type { HookEvent, SyncEventResult } from '../../src/types.js';

const paths = {
  pendingPath: '/sync/events/pending',
  processingPath: '/sync/events/processing',
  processedPath: '/sync/events/processed',
  failedPath: '/sync/events/failed',
  instancesPath: '/sync/instances',
  processedByCommitPath: '/sync/processed-commits',
};

function event(): Omit<HookEvent, 'eventId'> {
  return {
    provider: 'github',
    repo: 'org/app',
    url: 'https://github.com/org/app.git',
    ref: 'refs/heads/main',
    after: 'abcdef1234567890',
    receivedAt: Date.now(),
  };
}

function resultFor(eventId: string): SyncEventResult {
  return {
    eventId,
    sourceRepo: 'org/app',
    sourceSha: 'abcdef1234567890',
    startedAt: 1,
    completedAt: 2,
    instanceId: 'worker-1',
    destinations: [],
  };
}

test('listener lifecycle moves pending to processed and writes its own result', async () => {
  const client = new MemoryRtdbClient();
  const payload = event();
  await client.set(`${paths.pendingPath}/evt-1`, payload);
  const claimed = await processPendingEvent('evt-1', payload, {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    maxEventRetries: 3,
    logger: createLogger('error'),
    handler: async (hook) => resultFor(hook.eventId),
  });
  assert.equal(claimed, true);
  assert.equal(await client.get(`${paths.pendingPath}/evt-1`), null);
  assert.equal(await client.get(`${paths.processingPath}/${commitKeyOf(payload)}`), null);
  assert.equal((await client.get<{ eventId: string }>(`${paths.processedPath}/evt-1`))?.eventId, 'evt-1');
  assert.notEqual(await client.get(`${paths.processedByCommitPath}/${commitKeyOf(payload)}`), null);
});

test('two deliveries of the same commit process once and skip the second', async () => {
  const client = new MemoryRtdbClient();
  const payload = event();
  await client.set(`${paths.pendingPath}/evt-a`, payload);
  await client.set(`${paths.pendingPath}/evt-b`, { ...payload, receivedAt: Date.now() + 1 });
  let handled = 0;
  const options = {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    maxEventRetries: 3,
    logger: createLogger('error'),
    handler: async (hook: HookEvent) => {
      handled += 1;
      return resultFor(hook.eventId);
    },
  };
  assert.equal(await processPendingEvent('evt-a', payload, options), true);
  assert.equal(await processPendingEvent('evt-b', { ...payload, receivedAt: Date.now() + 1 }, options), true);
  assert.equal(handled, 1);
  assert.equal(await client.get(`${paths.pendingPath}/evt-a`), null);
  assert.equal(await client.get(`${paths.pendingPath}/evt-b`), null);
  assert.equal(await client.get(`${paths.processingPath}/${commitKeyOf(payload)}`), null);
  assert.equal(await client.get(`${paths.processedPath}/evt-b`), null);
  const marker = await client.get<{ eventId: string }>(`${paths.processedByCommitPath}/${commitKeyOf(payload)}`);
  assert.equal(marker?.eventId, 'evt-a');
});

test('racing instances claim the same commit only once', async () => {
  const client = new MemoryRtdbClient();
  const payload = event();
  let handled = 0;
  const options = {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    maxEventRetries: 3,
    logger: createLogger('error'),
    handler: async (hook: HookEvent) => {
      handled += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return resultFor(hook.eventId);
    },
  };
  const results = await Promise.all([
    processPendingEvent('evt-a', payload, options),
    processPendingEvent('evt-b', { ...payload, receivedAt: Date.now() + 1 }, { ...options, instanceId: 'worker-2' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(handled, 1);
});

test('expired processing record is returned to pending', async () => {
  const client = new MemoryRtdbClient();
  const payload = { ...event(), _eventId: 'evt-expired' };
  await client.set(`${paths.processingPath}/${commitKeyOf(payload)}`, {
    owner: 'dead-worker',
    expiresAt: 10,
    payload,
  });
  assert.equal(await recoverExpiredJobs(client, paths, 20), 1);
  assert.notEqual(await client.get(`${paths.pendingPath}/evt-expired`), null);
  assert.equal(await client.get(`${paths.processingPath}/${commitKeyOf(payload)}`), null);
});

test('retryable failure requeues the event back to pending', async () => {
  const client = new MemoryRtdbClient();
  const payload = event();
  await client.set(`${paths.pendingPath}/evt-retry`, payload);
  const error = new AppError('DESTINATION_LOCKED', 'locked', { retryable: true });
  const claimed = await processPendingEvent('evt-retry', payload, {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    maxEventRetries: 3,
    logger: createLogger('error'),
    handler: async () => {
      throw error;
    },
  });
  assert.equal(claimed, true);
  const requeued = await client.get<{ _retries?: number }>(`${paths.pendingPath}/evt-retry`);
  assert.equal(requeued?._retries, 1);
  assert.equal(await client.get(`${paths.processingPath}/evt-retry`), null);
  assert.equal(await client.get(`${paths.failedPath}/evt-retry`), null);
});

test('retryable failure exceeds retry budget and moves to failed', async () => {
  const client = new MemoryRtdbClient();
  const payload = { ...event(), _retries: 3 };
  await client.set(`${paths.pendingPath}/evt-exhausted`, payload);
  const error = new AppError('DESTINATION_LOCKED', 'locked', { retryable: true });
  const claimed = await processPendingEvent('evt-exhausted', payload, {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    maxEventRetries: 3,
    logger: createLogger('error'),
    handler: async () => {
      throw error;
    },
  });
  assert.equal(claimed, true);
  assert.equal(await client.get(`${paths.pendingPath}/evt-exhausted`), null);
  assert.notEqual(await client.get(`${paths.failedPath}/evt-exhausted`), null);
});

test('cleanupOldEvents removes processed and failed entries older than retention', async () => {
  const client = new MemoryRtdbClient();
  const now = Date.now();
  await client.set(`${paths.processedPath}/old-ok`, { completedAt: now - 8 * 86_400_000 });
  await client.set(`${paths.failedPath}/old-fail`, { failedAt: now - 9 * 86_400_000 });
  await client.set(`${paths.processedPath}/fresh`, { completedAt: now - 1 * 86_400_000 });
  await client.set(`${paths.processedByCommitPath}/old-commit`, { completedAt: now - 10 * 86_400_000 });
  await client.set(`${paths.processedByCommitPath}/fresh-commit`, { completedAt: now - 1 * 86_400_000 });
  const removed = await cleanupOldEvents(client, paths, 7, now);
  assert.equal(removed, 3);
  assert.equal(await client.get(`${paths.processedPath}/old-ok`), null);
  assert.equal(await client.get(`${paths.failedPath}/old-fail`), null);
  assert.notEqual(await client.get(`${paths.processedPath}/fresh`), null);
  assert.equal(await client.get(`${paths.processedByCommitPath}/old-commit`), null);
  assert.notEqual(await client.get(`${paths.processedByCommitPath}/fresh-commit`), null);
});
