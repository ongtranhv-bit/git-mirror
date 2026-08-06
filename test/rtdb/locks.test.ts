import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { acquireDestinationLock, claimEventAtomically, releaseDestinationLock } from '../../src/rtdb/locks.js';

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
