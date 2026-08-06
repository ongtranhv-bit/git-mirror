import test from 'node:test';
import assert from 'node:assert/strict';
import { processPendingEvent, recoverExpiredJobs } from '../../src/rtdb/events.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import type { HookEvent } from '../../src/types.js';

const paths = {
  pendingPath: '/sync/events/pending',
  processingPath: '/sync/events/processing',
  processedPath: '/sync/events/processed',
  failedPath: '/sync/events/failed',
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

test('listener lifecycle moves pending to processed and writes its own result', async () => {
  const client = new MemoryRtdbClient();
  const payload = event();
  await client.set(`${paths.pendingPath}/evt-1`, payload);
  const claimed = await processPendingEvent('evt-1', payload, {
    client,
    paths,
    instanceId: 'worker-1',
    lockTtlSeconds: 60,
    logger: createLogger('error'),
    handler: async (hook) => ({
      eventId: hook.eventId,
      sourceRepo: hook.repo,
      sourceSha: hook.after,
      startedAt: 1,
      completedAt: 2,
      instanceId: 'worker-1',
      destinations: [],
    }),
  });
  assert.equal(claimed, true);
  assert.equal(await client.get(`${paths.pendingPath}/evt-1`), null);
  assert.equal(await client.get(`${paths.processingPath}/evt-1`), null);
  assert.equal((await client.get<{ eventId: string }>(`${paths.processedPath}/evt-1`))?.eventId, 'evt-1');
});

test('expired processing record is returned to pending', async () => {
  const client = new MemoryRtdbClient();
  await client.set(`${paths.processingPath}/evt-expired`, {
    owner: 'dead-worker',
    expiresAt: 10,
    payload: event(),
  });
  assert.equal(await recoverExpiredJobs(client, paths, 20), 1);
  assert.notEqual(await client.get(`${paths.pendingPath}/evt-expired`), null);
  assert.equal(await client.get(`${paths.processingPath}/evt-expired`), null);
});
