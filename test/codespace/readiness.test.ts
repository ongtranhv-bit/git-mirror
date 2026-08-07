import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { findReadyInstance } from '../../src/codespace/readiness.js';
import type { RuntimeReadinessRecord } from '../../src/codespace/types.js';

test('readiness requires listener, exact commit, and fresh heartbeat', async () => {
  const client = new MemoryRtdbClient();
  const base: RuntimeReadinessRecord = {
    instanceId: 'i1', codespaceName: 'cs1', status: 'ready', runtimeCommitSha: 'abc',
    rtdbConnected: true, listenerAttached: true, startedAt: 900, readyAt: 950, heartbeatAt: 1000,
  };
  await client.set('/sync/codespace/instances/i1', base);
  assert.equal((await findReadyInstance({ client, instancesPath: '/sync/codespace/instances', codespaceName: 'cs1', expectedCommitSha: 'abc', freshnessMs: 100, now: 1050 }))?.instanceId, 'i1');
  assert.equal(await findReadyInstance({ client, instancesPath: '/sync/codespace/instances', codespaceName: 'cs1', expectedCommitSha: 'wrong', freshnessMs: 100, now: 1050 }), undefined);
  await client.set('/sync/codespace/instances/i1', { ...base, listenerAttached: false });
  assert.equal(await findReadyInstance({ client, instancesPath: '/sync/codespace/instances', codespaceName: 'cs1', expectedCommitSha: 'abc', freshnessMs: 100, now: 1050 }), undefined);
});
