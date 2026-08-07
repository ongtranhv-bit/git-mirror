import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import { loadRotationConfig, rotationConfigHash } from '../../src/codespace/config.js';
import { FakeCodespaceLifecycle } from '../../src/codespace/fake-lifecycle.js';
import { cleanupCodespaceRotation, rotateCodespace, type RotationClock } from '../../src/codespace/rotation.js';
import type { CodespaceInfo, CreateCodespaceInput, RotationRecord, RuntimeReadinessRecord } from '../../src/codespace/types.js';

function configRaw(stopOldAfterHealthy = false): string {
  return JSON.stringify({
    configVersion: 1, enabled: true, timezone: 'Asia/Ho_Chi_Minh', startAt: '23:00',
    days: { '7': { enabled: true, codespaceAccount: { expectedLogin: 'user07', tokenEnv: 'TOKEN_07' } } },
    bootstrap: { owner: 'org', repo: 'runner', branch: 'main', machine: 'standardLinux' },
    runtime: { rotationLockTtlSeconds: 60, healthPollSeconds: 1, healthTimeoutSeconds: 5, maxRetries: 0, retryBackoffMs: 1, stabilizationSeconds: 0, stopOldAfterHealthy, deleteOldAfterStop: false },
    testing: { enabled: false },
  });
}

class FakeClock implements RotationClock {
  value = 1_000_000;
  now(): number { return this.value; }
  async sleep(ms: number): Promise<void> { this.value += ms; }
}

class ReadyLifecycle extends FakeCodespaceLifecycle {
  constructor(private readonly client: MemoryRtdbClient, private readonly clock: FakeClock, options: ConstructorParameters<typeof FakeCodespaceLifecycle>[0] = {}) {
    super({ login: 'user07', repositoryHead: 'abc123', machines: [{ name: 'standardLinux' }], ...options });
  }
  override async create(input: CreateCodespaceInput): Promise<CodespaceInfo> {
    const created = await super.create(input);
    const ready: RuntimeReadinessRecord = {
      instanceId: 'new-instance', codespaceName: created.name, status: 'ready', repository: 'org/runner', branch: 'main', runtimeCommitSha: 'abc123',
      serviceVersion: 'test', rtdbConnected: true, listenerAttached: true, startedAt: this.clock.now(), readyAt: this.clock.now(), heartbeatAt: this.clock.now(), currentEvent: null,
    };
    await this.client.set('/sync/codespace/instances/new-instance', ready);
    return created;
  }
}

test('rotation promotes only after runtime readiness and is idempotent once completed', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const config = await loadRotationConfig({ raw: configRaw() });
  const lifecycle = new ReadyLifecycle(client, clock);
  const input = {
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'), env: { TOKEN_07: 'secret-token' }, clock,
    lifecycleFactory: () => lifecycle,
  };
  const record = await rotateCodespace(input);
  assert.equal(record.status, 'completed');
  assert.equal(record.checks.runtimeReady, true);
  assert.equal((await client.get<{ commitSha: string }>('/sync/codespace/active'))?.commitSha, 'abc123');
  const again = await rotateCodespace(input);
  assert.equal(again.status, 'completed');
  assert.equal(lifecycle.created.length, 1);
});

test('identity mismatch fails before Codespace create', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const config = await loadRotationConfig({ raw: configRaw() });
  const lifecycle = new FakeCodespaceLifecycle({ login: 'wrong-user', repositoryHead: 'abc123' });
  await assert.rejects(() => rotateCodespace({
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'), env: { TOKEN_07: 'secret-token' }, clock,
    lifecycleFactory: () => lifecycle,
  }), /expected user07/);
  assert.equal(lifecycle.created.length, 0);
  const active = await client.get('/sync/codespace/active');
  assert.equal(active, null);
});

class StaticOldLifecycle extends FakeCodespaceLifecycle {
  constructor() { super({ login: 'old-user', repositoryHead: 'oldsha', machines: [{ name: 'standardLinux' }] }); }
  override async get(name: string): Promise<CodespaceInfo> { return { name, state: 'Available', repository: 'org/runner', ownerLogin: 'old-user' }; }
  override async start(name: string): Promise<CodespaceInfo> { return this.get(name); }
  override async stop(name: string): Promise<CodespaceInfo> { this.stopped.push(name); return { name, state: 'Shutdown', repository: 'org/runner', ownerLogin: 'old-user' }; }
}

test('failure after promote rolls active pointer back to previous healthy Codespace', async () => {
  const client = new MemoryRtdbClient();
  const baseClock = new FakeClock();
  const config = await loadRotationConfig({ raw: JSON.stringify({
    ...JSON.parse(configRaw()),
    runtime: { ...JSON.parse(configRaw()).runtime, stabilizationSeconds: 1 },
  }) });
  await client.set('/sync/codespace/active', {
    codespaceName: 'old-cs', ownerLogin: 'old-user', credentialProfile: 'OLD_TOKEN', commitSha: 'oldsha', instanceId: 'old-i', promotedAt: 1,
  });
  const newLifecycle = new ReadyLifecycle(client, baseClock);
  const oldLifecycle = new StaticOldLifecycle();
  let destabilized = false;
  const clock: RotationClock = {
    now: () => baseClock.now(),
    sleep: async (ms) => {
      await baseClock.sleep(ms);
      if (!destabilized) {
        destabilized = true;
        const newReady = await client.get<RuntimeReadinessRecord>('/sync/codespace/instances/new-instance');
        if (newReady) await client.set('/sync/codespace/instances/new-instance', { ...newReady, listenerAttached: false, heartbeatAt: baseClock.now() });
        await client.set('/sync/codespace/instances/old-restarted', {
          instanceId: 'old-restarted', codespaceName: 'old-cs', status: 'ready', repository: 'org/runner', branch: 'main', runtimeCommitSha: 'oldsha',
          serviceVersion: 'test', rtdbConnected: true, listenerAttached: true, startedAt: baseClock.now(), readyAt: baseClock.now(), heartbeatAt: baseClock.now(), currentEvent: null,
        } satisfies RuntimeReadinessRecord);
      }
    },
  };
  await assert.rejects(() => rotateCodespace({
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'),
    env: { TOKEN_07: 'new-token', OLD_TOKEN: 'old-token' }, clock,
    lifecycleFactory: (profile) => profile === 'OLD_TOKEN' ? oldLifecycle : newLifecycle,
  }), /lost readiness/);
  const active = await client.get<{ codespaceName: string; commitSha: string }>('/sync/codespace/active');
  assert.equal(active?.codespaceName, 'old-cs');
  assert.equal(active?.commitSha, 'oldsha');
  const record = await client.get<RotationRecord>('/sync/codespace/rotations/2026-08-07');
  assert.equal(record?.status, 'rolled_back');
});

class RecoveredLifecycle extends FakeCodespaceLifecycle {
  createCalls = 0;
  constructor(private readonly recovered: CodespaceInfo) {
    super({ login: 'user07', repositoryHead: 'abc123', machines: [{ name: 'standardLinux' }] });
  }
  override async list(): Promise<CodespaceInfo[]> { return [this.recovered]; }
  override async create(input: CreateCodespaceInput): Promise<CodespaceInfo> {
    this.createCalls += 1;
    return super.create(input);
  }
  override async get(name: string): Promise<CodespaceInfo> { return { ...this.recovered, name, state: 'Available' }; }
}

test('retry recovers deterministic Codespace created before RTDB state was persisted', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const config = await loadRotationConfig({ raw: configRaw() });
  const recovered: CodespaceInfo = {
    name: 'recovered-cs', state: 'Available', repository: 'org/runner', ownerLogin: 'user07', displayName: 'git-mirror-2026-08-07',
  };
  const lifecycle = new RecoveredLifecycle(recovered);
  await client.set('/sync/codespace/rotations/2026-08-07', {
    rotationKey: '2026-08-07', dayOfMonth: 7, status: 'create_requested', configHash: rotationConfigHash(config), bootstrapRepository: 'org/runner',
    expectedCommitSha: 'abc123', checks: { tokenIdentity: true, repositoryHead: true, machineAvailable: true }, startedAt: clock.now(), updatedAt: clock.now(),
  } satisfies RotationRecord);
  await client.set('/sync/codespace/instances/recovered-i', {
    instanceId: 'recovered-i', codespaceName: 'recovered-cs', status: 'ready', runtimeCommitSha: 'abc123', rtdbConnected: true, listenerAttached: true,
    startedAt: clock.now(), readyAt: clock.now(), heartbeatAt: clock.now(), currentEvent: null,
  } satisfies RuntimeReadinessRecord);
  const record = await rotateCodespace({
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'), env: { TOKEN_07: 'secret-token' }, clock,
    lifecycleFactory: () => lifecycle,
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.next?.codespaceName, 'recovered-cs');
  assert.equal(lifecycle.createCalls, 0);
});

test('unfinished rotation refuses changed config snapshot', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const config = await loadRotationConfig({ raw: configRaw() });
  await client.set('/sync/codespace/rotations/2026-08-07', {
    rotationKey: '2026-08-07', dayOfMonth: 7, status: 'claimed', configHash: 'different-hash', bootstrapRepository: 'org/runner', checks: {}, startedAt: 1, updatedAt: 1,
  } satisfies RotationRecord);
  await assert.rejects(() => rotateCodespace({
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'), env: { TOKEN_07: 'secret-token' }, clock,
    lifecycleFactory: () => new ReadyLifecycle(client, clock),
  }), /refusing to mix snapshots/);
});

test('cleanup retries stopping previous Codespace after promotion without changing active new pointer', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const config = await loadRotationConfig({ raw: configRaw(true) });
  await client.set('/sync/codespace/active', {
    codespaceName: 'new-cs', ownerLogin: 'user07', credentialProfile: 'TOKEN_07', commitSha: 'abc123', promotedAt: 10,
  });
  await client.set('/sync/codespace/rotations/2026-08-07', {
    rotationKey: '2026-08-07', dayOfMonth: 7, status: 'cleanup_pending', configHash: rotationConfigHash(config), bootstrapRepository: 'org/runner',
    expectedCommitSha: 'abc123', checks: {}, startedAt: 1, updatedAt: 2,
    previous: { codespaceName: 'old-cs', ownerLogin: 'old-user', credentialProfile: 'OLD_TOKEN', commitSha: 'oldsha' },
    next: { codespaceName: 'new-cs', ownerLogin: 'user07', credentialProfile: 'TOKEN_07', commitSha: 'abc123' },
    cleanup: { required: true },
  } satisfies RotationRecord);
  const oldLifecycle = new StaticOldLifecycle();
  const record = await cleanupCodespaceRotation({
    config, client, logger: createLogger('error'), ownerId: 'cleanup-owner', env: { OLD_TOKEN: 'old-token', TOKEN_07: 'new-token' }, clock,
    lifecycleFactory: (profile) => profile === 'OLD_TOKEN' ? oldLifecycle : new FakeCodespaceLifecycle({ login: 'user07' }),
  }, '2026-08-07');
  assert.equal(record.status, 'completed');
  assert.equal(record.cleanup?.required, false);
  assert.deepEqual(oldLifecycle.stopped, ['old-cs']);
  assert.equal((await client.get<{ codespaceName: string }>('/sync/codespace/active'))?.codespaceName, 'new-cs');
});

test('testing config blocks real lifecycle even when rotateCodespace is called directly', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const raw = JSON.parse(configRaw());
  raw.testing = { ...raw.testing, enabled: true, useRealCodespace: false, tokenDay: 7 };
  const config = await loadRotationConfig({ raw: JSON.stringify(raw), env: { NODE_ENV: 'test' } });
  await assert.rejects(() => rotateCodespace({
    config, client, logger: createLogger('error'), ownerId: 'owner-1', date: new Date('2026-08-07T05:00:00Z'), env: { TOKEN_07: 'secret-token' }, clock,
  }), /fake lifecycleFactory is required/);
  assert.equal(await client.get('/sync/codespace/active'), null);
});

test('manual cleanup is stop-only even if current config now enables deleteOldAfterStop', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const raw = JSON.parse(configRaw(true));
  raw.runtime.deleteOldAfterStop = true;
  const config = await loadRotationConfig({ raw: JSON.stringify(raw) });
  await client.set('/sync/codespace/active', {
    codespaceName: 'new-cs', ownerLogin: 'user07', credentialProfile: 'TOKEN_07', commitSha: 'abc123', promotedAt: 10,
  });
  await client.set('/sync/codespace/rotations/2026-08-07', {
    rotationKey: '2026-08-07', dayOfMonth: 7, status: 'cleanup_pending', configHash: 'older-config-hash', bootstrapRepository: 'org/runner',
    expectedCommitSha: 'abc123', checks: {}, startedAt: 1, updatedAt: 2,
    previous: { codespaceName: 'old-cs', ownerLogin: 'old-user', credentialProfile: 'OLD_TOKEN', commitSha: 'oldsha' },
    next: { codespaceName: 'new-cs', ownerLogin: 'user07', credentialProfile: 'TOKEN_07', commitSha: 'abc123' },
    cleanup: { required: true },
  } satisfies RotationRecord);
  const oldLifecycle = new StaticOldLifecycle();
  const record = await cleanupCodespaceRotation({
    config, client, logger: createLogger('error'), ownerId: 'cleanup-owner', env: { OLD_TOKEN: 'old-token', TOKEN_07: 'new-token' }, clock,
    lifecycleFactory: (profile) => profile === 'OLD_TOKEN' ? oldLifecycle : new FakeCodespaceLifecycle({ login: 'user07' }),
  }, '2026-08-07');
  assert.equal(record.status, 'completed');
  assert.deepEqual(oldLifecycle.stopped, ['old-cs']);
  assert.deepEqual(oldLifecycle.deleted, []);
});

test('live rotation records asynchronous old Codespace deletion as requested, not completed', async () => {
  const client = new MemoryRtdbClient();
  const clock = new FakeClock();
  const raw = JSON.parse(configRaw(true));
  raw.runtime.deleteOldAfterStop = true;
  const config = await loadRotationConfig({ raw: JSON.stringify(raw) });
  await client.set('/sync/codespace/active', {
    codespaceName: 'old-cs', ownerLogin: 'old-user', credentialProfile: 'OLD_TOKEN', commitSha: 'oldsha', promotedAt: 10,
  });
  const newLifecycle = new ReadyLifecycle(client, clock);
  const oldLifecycle = new StaticOldLifecycle();
  const record = await rotateCodespace({
    config,
    client,
    logger: createLogger('error'),
    ownerId: 'owner-1',
    date: new Date('2026-08-07T05:00:00Z'),
    env: { TOKEN_07: 'new-token', OLD_TOKEN: 'old-token' },
    clock,
    lifecycleFactory: (profile) => profile === 'OLD_TOKEN' ? oldLifecycle : newLifecycle,
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.cleanup?.stopped, true);
  assert.equal(record.cleanup?.deleteRequested, true);
  assert.equal(record.cleanup?.deleted, undefined);
  assert.deepEqual(oldLifecycle.deleted, ['old-cs']);
});
