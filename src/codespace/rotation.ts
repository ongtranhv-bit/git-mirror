import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../shared/logger.js';
import { AppError, toAppError, toPublicError } from '../shared/errors.js';
import { withRetry } from '../shared/retry.js';
import type { RtdbClient } from '../rtdb/client.js';
import { rotationConfigHash, resolveDayConfig, resolveRotationDay } from './config.js';
import { resolveLifecycleCredential, resolveLifecycleToken } from './credentials.js';
import { GitHubCodespaceLifecycle } from './github-lifecycle.js';
import { acquireRotationLock, refreshRotationLock, releaseRotationLock } from './lock.js';
import { findReadyInstance } from './readiness.js';
import { getRotationRecord, promoteActive, putRotationRecord, rotationPaths } from './state.js';
import type {
  ActiveCodespacePointer,
  CodespaceLifecycle,
  RotationConfig,
  RotationRecord,
  RotationStatus,
} from './types.js';

export interface RotationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: RotationClock = { now: () => Date.now(), sleep: (ms) => delay(ms) };

export interface RotateCodespaceInput {
  config: RotationConfig;
  client: RtdbClient;
  logger: Logger;
  ownerId: string;
  date?: Date;
  env?: NodeJS.ProcessEnv;
  basePath?: string;
  clock?: RotationClock;
  lifecycleFactory?: (profile: string, token: string) => CodespaceLifecycle;
  noStopOld?: boolean;
  displayNamePrefix?: string;
}

export async function rotateCodespace(input: RotateCodespaceInput): Promise<RotationRecord> {
  const env = input.env ?? process.env;
  const clock = input.clock ?? SYSTEM_CLOCK;
  const paths = rotationPaths(input.basePath);
  if (!input.config.enabled) throw new AppError('CODESPACE_ROTATION_DISABLED', 'Codespace rotation is disabled.');
  if (input.config.testing.enabled && !input.config.testing.useRealCodespace && !input.lifecycleFactory) {
    throw new AppError('CODESPACE_TEST_REAL_CREATE_BLOCKED', 'Testing config has useRealCodespace=false; a fake lifecycleFactory is required.');
  }

  const resolved = resolveRotationDay(input.config, input.date ?? new Date(clock.now()));
  const selectedDay = input.config.testing.enabled && input.config.testing.tokenDay
    ? input.config.testing.tokenDay
    : resolved.dayOfMonth;
  const day = resolveDayConfig(input.config, selectedDay);
  const credential = resolveLifecycleCredential(day, env);
  const existing = await getRotationRecord(input.client, paths.rotations, resolved.rotationKey);
  if (existing?.status === 'completed' || existing?.status === 'rolled_back') return existing;
  const currentConfigHash = rotationConfigHash(input.config);
  if (existing && existing.configHash !== currentConfigHash) {
    throw new AppError('CODESPACE_CONFIG_CHANGED_DURING_ROTATION', 'Rotation config changed for an existing unfinished rotation; refusing to mix snapshots.');
  }

  const locked = await acquireRotationLock(input.client, paths.lock, input.ownerId, resolved.rotationKey, input.config.runtime.rotationLockTtlSeconds);
  if (!locked) throw new AppError('CODESPACE_ROTATION_LOCKED', 'Another orchestrator owns the global Codespace rotation lock.', { retryable: true });

  const lifecycleFactory = input.lifecycleFactory ?? ((_profile, token) => new GitHubCodespaceLifecycle(token));
  const currentLifecycle = lifecycleFactory(credential.profile, credential.token);
  let record = existing ?? createInitialRecord(input.config, resolved.rotationKey, resolved.dayOfMonth, clock.now());
  const lockLease = startLockHeartbeat(input, paths.lock, clock);
  let promoted = record.status === 'promoted' || record.status === 'old_stop_requested' || record.status === 'completed' || record.status === 'cleanup_pending';

  try {
    record = await updateRecord(input, paths.rotations, record, 'claimed', clock);
    lockLease.assertOwned();
    const identity = await withRetry(() => currentLifecycle.getAuthenticatedUser(), retryOptions(input, 'identity'));
    lockLease.assertOwned();
    if (identity.login !== credential.expectedLogin) {
      throw new AppError('CODESPACE_TOKEN_IDENTITY_MISMATCH', `Lifecycle credential resolved to ${identity.login}, expected ${credential.expectedLogin}.`);
    }
    record.checks.tokenIdentity = true;

    const expectedSha = record.expectedCommitSha ?? await withRetry(
      () => currentLifecycle.resolveRepositoryHead(input.config.bootstrap.owner, input.config.bootstrap.repo, input.config.bootstrap.branch),
      retryOptions(input, 'repository-head'),
    );
    record.expectedCommitSha = expectedSha;
    record.checks.repositoryHead = true;
    lockLease.assertOwned();

    const machines = await withRetry(
      () => currentLifecycle.listMachines(input.config.bootstrap.owner, input.config.bootstrap.repo),
      retryOptions(input, 'machines'),
    );
    if (input.config.bootstrap.machine && !machines.some((machine) => machine.name === input.config.bootstrap.machine)) {
      throw new AppError('CODESPACE_MACHINE_UNAVAILABLE', `Configured machine ${input.config.bootstrap.machine} is not available for bootstrap repository.`);
    }
    record.checks.machineAvailable = true;
    lockLease.assertOwned();
    record = await updateRecord(input, paths.rotations, record, 'preflight_ok', clock);

    if (!record.next?.codespaceName) {
      record = await updateRecord(input, paths.rotations, record, 'create_requested', clock);
      lockLease.assertOwned();
      const displayName = `${input.displayNamePrefix ?? 'git-mirror'}-${resolved.rotationKey}`;
      const existingByDisplay = (await currentLifecycle.list()).filter((item) => item.displayName === displayName);
      if (existingByDisplay.length > 1) {
        throw new AppError('CODESPACE_RECOVERY_AMBIGUOUS', `Multiple Codespaces use deterministic display name ${displayName}.`);
      }
      const created = existingByDisplay[0] ?? await withRetry(
        () => currentLifecycle.create({
          owner: input.config.bootstrap.owner,
          repo: input.config.bootstrap.repo,
          branch: input.config.bootstrap.branch,
          ...(input.config.bootstrap.machine ? { machine: input.config.bootstrap.machine } : {}),
          ...(input.config.bootstrap.devcontainerPath ? { devcontainerPath: input.config.bootstrap.devcontainerPath } : {}),
          displayName,
          ...(input.config.bootstrap.idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes: input.config.bootstrap.idleTimeoutMinutes } : {}),
          ...(input.config.bootstrap.retentionPeriodDays !== undefined
            ? { retentionPeriodMinutes: input.config.bootstrap.retentionPeriodDays * 24 * 60 }
            : {}),
        }),
        retryOptions(input, 'create'),
      );
      record.next = {
        codespaceName: created.name,
        ownerLogin: identity.login,
        credentialProfile: credential.profile,
        commitSha: expectedSha,
      };
      await putRotationRecord(input.client, paths.rotations, { ...record, updatedAt: clock.now() });
    }

    const nextEndpoint = record.next;
    if (!nextEndpoint) throw new AppError('CODESPACE_STATE_INVALID', 'Rotation record has no new Codespace after create step.');
    const newName = nextEndpoint.codespaceName;
    await pollUntil(input, async () => {
      const info = await currentLifecycle.get(newName);
      return info.state.toLowerCase() === 'available';
    }, 'CODESPACE_AVAILABLE_TIMEOUT', lockLease.assertOwned);
    record.checks.codespaceAvailable = true;
    record = await updateRecord(input, paths.rotations, record, 'codespace_available', clock);

    const readiness = await pollForReadiness(input, paths.instances, newName, expectedSha, lockLease.assertOwned);
    record.runtimeCommitSha = readiness.runtimeCommitSha;
    nextEndpoint.instanceId = readiness.instanceId;
    record.next = nextEndpoint;
    record.checks.runtimeReady = true;
    record.checks.runtimeCommitMatches = readiness.runtimeCommitSha === expectedSha;
    record.checks.heartbeatFresh = true;
    record = await updateRecord(input, paths.rotations, record, 'runtime_ready', clock);

    if (!promoted) {
      const previous = await input.client.get<ActiveCodespacePointer>(paths.active);
      record.previous = previous ? {
        codespaceName: previous.codespaceName,
        ownerLogin: previous.ownerLogin,
        credentialProfile: previous.credentialProfile,
        commitSha: previous.commitSha,
        ...(previous.instanceId ? { instanceId: previous.instanceId } : {}),
      } : undefined;
      const nextPointer: ActiveCodespacePointer = {
        codespaceName: newName,
        ownerLogin: identity.login,
        credentialProfile: credential.profile,
        commitSha: expectedSha,
        instanceId: readiness.instanceId,
        promotedAt: clock.now(),
      };
      lockLease.assertOwned();
      await promoteActive({ client: input.client, activePath: paths.active, ...(previous ? { previous } : {}), next: nextPointer });
      promoted = true;
      record.promotedAt = nextPointer.promotedAt;
      record = await updateRecord(input, paths.rotations, record, 'promoted', clock);
    }

    if (input.config.runtime.stabilizationSeconds > 0) {
      await clock.sleep(input.config.runtime.stabilizationSeconds * 1_000);
      lockLease.assertOwned();
      await requireReadiness(input, paths.instances, newName, expectedSha);
    }

    const shouldStopOld = input.noStopOld !== true
      && input.config.runtime.stopOldAfterHealthy
      && (!input.config.testing.enabled || input.config.testing.stopOldAfterHealthy);
    const previousEndpoint = record.previous;
    if (shouldStopOld && previousEndpoint?.codespaceName && previousEndpoint.codespaceName !== newName) {
      record = await updateRecord(input, paths.rotations, record, 'old_stop_requested', clock);
      try {
        lockLease.assertOwned();
        const previousLifecycle = lifecycleForStoredProfile(input, previousEndpoint.credentialProfile, env, lifecycleFactory);
        const previousIdentity = await previousLifecycle.getAuthenticatedUser();
        if (previousIdentity.login !== previousEndpoint.ownerLogin) {
          throw new AppError('CODESPACE_OLD_TOKEN_IDENTITY_MISMATCH', `Old lifecycle credential resolved to ${previousIdentity.login}, expected ${previousEndpoint.ownerLogin}.`);
        }
        await withRetry(() => previousLifecycle.stop(previousEndpoint.codespaceName), retryOptions(input, 'stop-old'));
        record.oldStoppedAt = clock.now();
        if (input.config.runtime.deleteOldAfterStop) {
          await previousLifecycle.delete(previousEndpoint.codespaceName);
          // GitHub accepts Codespace deletion asynchronously (HTTP 202). Record only
          // that deletion was requested; do not claim the resource is already gone.
          record.cleanup = { required: false, stopped: true, deleteRequested: true };
        }
      } catch (error) {
        record.error = toPublicError(error);
        record.cleanup = { required: true };
        record = await updateRecord(input, paths.rotations, record, 'cleanup_pending', clock);
        return record;
      }
    }

    record.completedAt = clock.now();
    record.error = undefined;
    record = await updateRecord(input, paths.rotations, record, 'completed', clock);
    return record;
  } catch (error) {
    const appError = toAppError(error);
    record.error = toPublicError(appError);
    if (promoted && record.previous && record.next) {
      try {
        record = await rollbackPromotedRotation({ input, paths, record, env, lifecycleFactory, clock, assertLock: lockLease.assertOwned });
      } catch (rollbackError) {
        record.cleanup = { required: true };
        record.error = {
          code: appError.code,
          message: `${appError.message}; rollback failed: ${toAppError(rollbackError).message}`,
          retryable: appError.retryable || toAppError(rollbackError).retryable,
        };
        record = await updateRecord(input, paths.rotations, record, 'rollback_pending', clock);
      }
    } else if (!promoted && record.next?.codespaceName) {
      try {
        lockLease.assertOwned();
        await currentLifecycle.stop(record.next.codespaceName);
        record.cleanup = { required: false, stopped: true };
      } catch {
        record.cleanup = { required: true };
      }
      const failureStatus: RotationStatus = record.cleanup?.required ? 'cleanup_pending' : 'failed';
      record = await updateRecord(input, paths.rotations, record, failureStatus, clock);
    } else {
      record = await updateRecord(input, paths.rotations, record, 'failed', clock);
    }
    throw appError;
  } finally {
    lockLease.stop();
    await releaseRotationLock(input.client, paths.lock, input.ownerId);
  }
}


async function rollbackPromotedRotation(input: {
  input: RotateCodespaceInput;
  paths: ReturnType<typeof rotationPaths>;
  record: RotationRecord;
  env: NodeJS.ProcessEnv;
  lifecycleFactory: (profile: string, token: string) => CodespaceLifecycle;
  clock: RotationClock;
  assertLock: () => void;
}): Promise<RotationRecord> {
  const previous = input.record.previous;
  const next = input.record.next;
  if (!previous || !next) throw new AppError('CODESPACE_ROLLBACK_STATE_INVALID', 'Rollback requires previous and next Codespace endpoints.');
  input.assertLock();
  let record = await updateRecord(input.input, input.paths.rotations, input.record, 'rollback_pending', input.clock);
  const oldLifecycle = lifecycleForStoredProfile(input.input, previous.credentialProfile, input.env, input.lifecycleFactory);
  const oldIdentity = await oldLifecycle.getAuthenticatedUser();
  if (oldIdentity.login !== previous.ownerLogin) {
    throw new AppError('CODESPACE_ROLLBACK_IDENTITY_MISMATCH', `Rollback credential resolved to ${oldIdentity.login}, expected ${previous.ownerLogin}.`);
  }
  input.assertLock();
  await withRetry(() => oldLifecycle.start(previous.codespaceName), retryOptions(input.input, 'rollback-start-old'));
  await pollUntil(input.input, async () => {
    const info = await oldLifecycle.get(previous.codespaceName);
    return info.state.toLowerCase() === 'available';
  }, 'CODESPACE_ROLLBACK_AVAILABLE_TIMEOUT', input.assertLock);
  const readiness = await pollForReadiness(input.input, input.paths.instances, previous.codespaceName, previous.commitSha, input.assertLock);
  const currentPointer: ActiveCodespacePointer = {
    codespaceName: next.codespaceName,
    ownerLogin: next.ownerLogin,
    credentialProfile: next.credentialProfile,
    commitSha: next.commitSha,
    ...(next.instanceId ? { instanceId: next.instanceId } : {}),
    promotedAt: record.promotedAt ?? input.clock.now(),
  };
  const previousPointer: ActiveCodespacePointer = {
    codespaceName: previous.codespaceName,
    ownerLogin: previous.ownerLogin,
    credentialProfile: previous.credentialProfile,
    commitSha: previous.commitSha,
    instanceId: readiness.instanceId,
    promotedAt: input.clock.now(),
  };
  input.assertLock();
  await promoteActive({ client: input.input.client, activePath: input.paths.active, previous: currentPointer, next: previousPointer });
  try {
    const newLifecycle = lifecycleForStoredProfile(input.input, next.credentialProfile, input.env, input.lifecycleFactory);
    await newLifecycle.stop(next.codespaceName);
    record.cleanup = { required: false, stopped: true };
  } catch {
    record.cleanup = { required: true };
  }
  record = await updateRecord(input.input, input.paths.rotations, record, 'rolled_back', input.clock);
  return record;
}

function createInitialRecord(config: RotationConfig, rotationKey: string, dayOfMonth: number, now: number): RotationRecord {
  return {
    rotationKey,
    dayOfMonth,
    status: 'planned',
    configHash: rotationConfigHash(config),
    bootstrapRepository: `${config.bootstrap.owner}/${config.bootstrap.repo}`,
    checks: {},
    startedAt: now,
    updatedAt: now,
  };
}

async function updateRecord(
  input: RotateCodespaceInput,
  rotationsPath: string,
  record: RotationRecord,
  status: RotationStatus,
  clock: RotationClock,
): Promise<RotationRecord> {
  const updated = { ...record, status, updatedAt: clock.now() };
  await putRotationRecord(input.client, rotationsPath, updated);
  input.logger.info({ rotationKey: record.rotationKey, status }, 'codespace.rotation_state');
  return updated;
}

function retryOptions(input: RotateCodespaceInput, operation: string) {
  return {
    retries: input.config.runtime.maxRetries,
    backoffMs: input.config.runtime.retryBackoffMs,
    onRetry: (error: AppError, attempt: number) => input.logger.warn({ operation, attempt, error: toPublicError(error) }, 'codespace.retry'),
  };
}

async function pollUntil(input: RotateCodespaceInput, check: () => Promise<boolean>, timeoutCode: string, assertLock: () => void = () => {}): Promise<void> {
  const clock = input.clock ?? SYSTEM_CLOCK;
  const deadline = clock.now() + input.config.runtime.healthTimeoutSeconds * 1_000;
  while (clock.now() <= deadline) {
    assertLock();
    if (await check()) return;
    await clock.sleep(input.config.runtime.healthPollSeconds * 1_000);
  }
  throw new AppError(timeoutCode, `Timed out after ${input.config.runtime.healthTimeoutSeconds}s.`, { retryable: true });
}

async function pollForReadiness(
  input: RotateCodespaceInput,
  instancesPath: string,
  codespaceName: string,
  expectedSha: string,
  assertLock: () => void = () => {},
) {
  let found: Awaited<ReturnType<typeof findReadyInstance>>;
  await pollUntil(input, async () => {
    found = await findReadyInstance({
      client: input.client,
      instancesPath,
      codespaceName,
      expectedCommitSha: expectedSha,
      freshnessMs: Math.max(input.config.runtime.healthPollSeconds * 3_000, 15_000),
      now: (input.clock ?? SYSTEM_CLOCK).now(),
    });
    return Boolean(found);
  }, 'CODESPACE_RUNTIME_READY_TIMEOUT', assertLock);
  if (!found) throw new AppError('CODESPACE_RUNTIME_READY_TIMEOUT', 'Runtime readiness record was not found.');
  return found;
}

async function requireReadiness(input: RotateCodespaceInput, instancesPath: string, codespaceName: string, expectedSha: string): Promise<void> {
  const found = await findReadyInstance({
    client: input.client,
    instancesPath,
    codespaceName,
    expectedCommitSha: expectedSha,
    freshnessMs: Math.max(input.config.runtime.healthPollSeconds * 3_000, 15_000),
    now: (input.clock ?? SYSTEM_CLOCK).now(),
  });
  if (!found) throw new AppError('CODESPACE_STABILIZATION_FAILED', 'Runtime lost readiness during stabilization.');
}

function lifecycleForStoredProfile(
  input: RotateCodespaceInput,
  profile: string,
  env: NodeJS.ProcessEnv,
  factory: (profile: string, token: string) => CodespaceLifecycle,
): CodespaceLifecycle {
  const token = resolveLifecycleToken(profile, env);
  return factory(profile, token);
}

function startLockHeartbeat(input: RotateCodespaceInput, path: string, clock: RotationClock): { stop(): void; assertOwned(): void } {
  const intervalMs = Math.max(5_000, Math.floor(input.config.runtime.rotationLockTtlSeconds * 1_000 / 3));
  let lost: AppError | undefined;
  const markLost = (error: unknown) => {
    if (lost) return;
    lost = toAppError(error, 'CODESPACE_ROTATION_LOCK_LOST');
    input.logger.error({ owner: input.ownerId, error: toPublicError(lost) }, 'codespace.rotation_lock_lost');
  };
  const timer = setInterval(() => {
    void refreshRotationLock(input.client, path, input.ownerId, input.config.runtime.rotationLockTtlSeconds)
      .then((ok) => {
        if (!ok) markLost(new AppError('CODESPACE_ROTATION_LOCK_LOST', 'Global rotation lock is no longer owned by this orchestrator.'));
      })
      .catch(markLost);
  }, intervalMs);
  timer.unref();
  void clock;
  return {
    stop: () => clearInterval(timer),
    assertOwned: () => {
      if (lost) throw lost;
    },
  };
}

export async function rollbackCodespaceRotation(input: RotateCodespaceInput, rotationKey: string): Promise<RotationRecord> {
  const env = input.env ?? process.env;
  const clock = input.clock ?? SYSTEM_CLOCK;
  const paths = rotationPaths(input.basePath);
  const record = await getRotationRecord(input.client, paths.rotations, rotationKey);
  if (!record) throw new AppError('CODESPACE_ROTATION_NOT_FOUND', `Rotation ${rotationKey} was not found.`);
  if (record.status === 'rolled_back') return record;
  if (!record.previous || !record.next) throw new AppError('CODESPACE_ROLLBACK_STATE_INVALID', 'Rotation has no previous/new endpoints to roll back.');
  const locked = await acquireRotationLock(input.client, paths.lock, input.ownerId, rotationKey, input.config.runtime.rotationLockTtlSeconds);
  if (!locked) throw new AppError('CODESPACE_ROTATION_LOCKED', 'Another orchestrator owns the global Codespace rotation lock.', { retryable: true });
  const lifecycleFactory = input.lifecycleFactory ?? ((_profile, token) => new GitHubCodespaceLifecycle(token));
  const lease = startLockHeartbeat(input, paths.lock, clock);
  try {
    return await rollbackPromotedRotation({ input, paths, record, env, lifecycleFactory, clock, assertLock: lease.assertOwned });
  } finally {
    lease.stop();
    await releaseRotationLock(input.client, paths.lock, input.ownerId);
  }
}

export async function cleanupCodespaceRotation(input: RotateCodespaceInput, rotationKey: string): Promise<RotationRecord> {
  const env = input.env ?? process.env;
  const clock = input.clock ?? SYSTEM_CLOCK;
  const paths = rotationPaths(input.basePath);
  let record = await getRotationRecord(input.client, paths.rotations, rotationKey);
  if (!record) throw new AppError('CODESPACE_ROTATION_NOT_FOUND', `Rotation ${rotationKey} was not found.`);
  if (!record.cleanup?.required) return record;
  if (!record.previous || !record.next) throw new AppError('CODESPACE_CLEANUP_STATE_INVALID', 'Cleanup requires previous and new Codespace endpoints.');
  const locked = await acquireRotationLock(input.client, paths.lock, input.ownerId, rotationKey, input.config.runtime.rotationLockTtlSeconds);
  if (!locked) throw new AppError('CODESPACE_ROTATION_LOCKED', 'Another orchestrator owns the global Codespace rotation lock.', { retryable: true });
  const lifecycleFactory = input.lifecycleFactory ?? ((_profile, token) => new GitHubCodespaceLifecycle(token));
  const lease = startLockHeartbeat(input, paths.lock, clock);
  try {
    lease.assertOwned();
    const active = await input.client.get<ActiveCodespacePointer>(paths.active);
    const target = active?.codespaceName === record.next.codespaceName ? record.previous
      : active?.codespaceName === record.previous.codespaceName ? record.next
      : undefined;
    if (!target) throw new AppError('CODESPACE_CLEANUP_ACTIVE_AMBIGUOUS', 'Active pointer does not match either endpoint in the rotation.');
    const lifecycle = lifecycleForStoredProfile(input, target.credentialProfile, env, lifecycleFactory);
    const identity = await lifecycle.getAuthenticatedUser();
    if (identity.login !== target.ownerLogin) {
      throw new AppError('CODESPACE_CLEANUP_IDENTITY_MISMATCH', `Cleanup credential resolved to ${identity.login}, expected ${target.ownerLogin}.`);
    }
    lease.assertOwned();
    await withRetry(() => lifecycle.stop(target.codespaceName), retryOptions(input, 'cleanup-stop'));
    // Manual cleanup is intentionally stop-only. It may run with a newer
    // config than the immutable rotation snapshot, so it must not inherit a
    // later deleteOldAfterStop=true and destroy the rollback target.
    record.cleanup = { required: false, stopped: true };
    record.error = undefined;
    const finalStatus: RotationStatus = active?.codespaceName === record.next.codespaceName ? 'completed' : 'rolled_back';
    if (finalStatus === 'completed') record.completedAt = clock.now();
    record = await updateRecord(input, paths.rotations, record, finalStatus, clock);
    return record;
  } finally {
    lease.stop();
    await releaseRotationLock(input.client, paths.lock, input.ownerId);
  }
}
