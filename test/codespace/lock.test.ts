import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { acquireRotationLock, releaseRotationLock } from '../../src/codespace/lock.js';

test('rotation lock is global across different rotation keys', async () => {
  const client = new MemoryRtdbClient();
  assert.equal(await acquireRotationLock(client, '/sync/codespace/lock', 'one', '2026-08-07', 60), true);
  assert.equal(await acquireRotationLock(client, '/sync/codespace/lock', 'two', '2026-08-08', 60), false);
  await releaseRotationLock(client, '/sync/codespace/lock', 'one');
  assert.equal(await acquireRotationLock(client, '/sync/codespace/lock', 'two', '2026-08-08', 60), true);
});
