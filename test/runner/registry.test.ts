import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import { sanitizeRtdbKey } from '../../src/shared/paths.js';
import { createRunnerLease, type RunnerRecord } from '../../src/runner/registry.js';
import type { RunnerIdentity } from '../../src/runner/identity.js';

const identity: RunnerIdentity = {
  provider: 'github',
  owner: 'org',
  repo: 'app',
  workflowFile: 'worker.yml',
  key: 'github:org/app:worker.yml',
  displayName: 'org/app (worker.yml)',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function path(): string {
  return `/sync/runners/${sanitizeRtdbKey(identity.key)}`;
}

test('first claim creates the record with generation 1', async () => {
  const client = new MemoryRtdbClient();
  const lease = await createRunnerLease({
    client,
    runnerPath: '/sync/runners',
    identity,
    ownerId: 'worker-a',
    ttlSeconds: 60,
    instancesPath: '/sync/instances',
    logger: createLogger('error'),
  });
  const record = await client.get<RunnerRecord>(path());
  assert.ok(record);
  assert.equal(record.generation, 1);
  assert.equal(record.ownerId, 'worker-a');
  assert.equal(record.key, identity.key);
  assert.equal(record.status, 'running');
  await lease.stop();
  const exited = await client.get<RunnerRecord>(path());
  assert.equal(exited?.status, 'exited');
});

test('a newer instance takes over and the old owner loses ownership', async () => {
  const client = new MemoryRtdbClient();
  const options = {
    client,
    runnerPath: '/sync/runners',
    identity,
    ttlSeconds: 60,
    instancesPath: '/sync/instances',
    logger: createLogger('error'),
  };
  const leaseA = await createRunnerLease({ ...options, ownerId: 'worker-a' });
  let lost: RunnerRecord | null | undefined;
  leaseA.onLost((record) => { lost = record; });

  const leaseB = await createRunnerLease({ ...options, ownerId: 'worker-b' });
  const record = await client.get<RunnerRecord>(path());
  assert.equal(record?.generation, 2);
  assert.equal(record?.ownerId, 'worker-b');

  await sleep(20);
  assert.ok(lost, 'old owner must be notified of ownership loss');
  assert.equal(lost?.generation, 2);

  await leaseA.stop();
  const afterA = await client.get<RunnerRecord>(path());
  assert.equal(afterA?.ownerId, 'worker-b', 'exiting old owner must not overwrite the new record');

  await leaseB.stop();
  const afterB = await client.get<RunnerRecord>(path());
  assert.equal(afterB?.ownerId, 'worker-b');
  assert.equal(afterB?.status, 'exited');
});

test('reconnecting with the same owner id refreshes without bumping generation', async () => {
  const client = new MemoryRtdbClient();
  const options = {
    client,
    runnerPath: '/sync/runners',
    identity,
    ttlSeconds: 60,
    instancesPath: '/sync/instances',
    logger: createLogger('error'),
  };
  await createRunnerLease({ ...options, ownerId: 'worker-a' });
  const leaseAgain = await createRunnerLease({ ...options, ownerId: 'worker-a' });
  const record = await client.get<RunnerRecord>(path());
  assert.equal(record?.generation, 1);
  assert.equal(record?.ownerId, 'worker-a');
  await leaseAgain.stop();
});

test('heartbeat refreshes expiresAt while owned', async () => {
  const client = new MemoryRtdbClient();
  const lease = await createRunnerLease({
    client,
    runnerPath: '/sync/runners',
    identity,
    ownerId: 'worker-a',
    ttlSeconds: 3,
    instancesPath: '/sync/instances',
    logger: createLogger('error'),
  });
  const before = await client.get<RunnerRecord>(path());
  await sleep(1_200);
  const after = await client.get<RunnerRecord>(path());
  assert.ok(after && before);
  assert.ok(after.heartbeatAt > before.heartbeatAt);
  assert.ok(after.expiresAt > before.expiresAt);
  await lease.stop();
});

test('update patch writes only while still owned', async () => {
  const client = new MemoryRtdbClient();
  const options = {
    client,
    runnerPath: '/sync/runners',
    identity,
    ttlSeconds: 60,
    instancesPath: '/sync/instances',
    logger: createLogger('error'),
  };
  const leaseA = await createRunnerLease({ ...options, ownerId: 'worker-a' });
  await leaseA.update({ configHash: 'abc123' });
  assert.equal((await client.get<RunnerRecord>(path()))?.configHash, 'abc123');

  await createRunnerLease({ ...options, ownerId: 'worker-b' });
  await leaseA.update({ configHash: 'stale' });
  assert.notEqual((await client.get<RunnerRecord>(path()))?.configHash, 'stale');
  await leaseA.stop();
});
