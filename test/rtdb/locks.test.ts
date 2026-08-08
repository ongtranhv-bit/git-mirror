import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { acquireDestinationLock, claimEventAtomically, isLockStale, releaseDestinationLock, type LockRecord } from '../../src/rtdb/locks.js';
import { sanitizeRtdbKey } from '../../src/shared/paths.js';

test('three workers claim each event exactly once', async () => {
  const client = new MemoryRtdbClient();
  for (let eventIndex = 0; eventIndex < 20; eventIndex += 1) {
    const claims = await Promise.all(
      ['worker-a', 'worker-b', 'worker-c'].map((worker) =>
        claimEventAtomically(client, '/processing', `event-${eventIndex}`, worker, 60, { eventIndex }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1);
  }
});

test('destination lock is owner-safe and can be released', async () => {
  const client = new MemoryRtdbClient();
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-a', 60), true);
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-b', 60), false);
  await releaseDestinationLock(client, '/locks', 'github/org/repo', 'worker-b');
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-b', 60), false);
  await releaseDestinationLock(client, '/locks', 'github/org/repo', 'worker-a');
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-b', 60), true);
});

test('destination lock is reclaimed when the holder heartbeat is stale', async () => {
  const client = new MemoryRtdbClient();
  const path = `/locks/${sanitizeRtdbKey('github/org/repo')}`;
  const now = Date.now();
  const stale: LockRecord = { owner: 'dead-worker', claimedAt: now - 120_000, heartbeatAt: now - 120_000, expiresAt: now + 30_000 };
  await client.set(path, stale);
  assert.equal(isLockStale(stale, 60, now), true);
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-b', 60), true);
  assert.equal(await releaseDestinationLock(client, '/locks', 'github/org/repo', 'worker-b'), undefined);
});

test('destination lock stays blocked while the holder heartbeat is fresh', async () => {
  const client = new MemoryRtdbClient();
  const now = Date.now();
  const alive: LockRecord = { owner: 'live-worker', claimedAt: now, heartbeatAt: now, expiresAt: now + 60_000 };
  await client.set(`/locks/${sanitizeRtdbKey('github/org/repo')}`, alive);
  assert.equal(isLockStale(alive, 60, now), false);
  assert.equal(await acquireDestinationLock(client, '/locks', 'github/org/repo', 'worker-b', 60), false);
});
