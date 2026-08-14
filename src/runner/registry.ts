import { AppError, toPublicError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { sanitizeRtdbKey } from '../shared/paths.js';
import type { RtdbClient } from '../rtdb/client.js';
import type { RunnerIdentity } from './identity.js';

export interface RunnerRecord {
  key: string;
  provider: string;
  owner: string;
  repo: string;
  workflowFile?: string;
  generation: number;
  ownerId: string;
  claimedAt: number;
  heartbeatAt: number;
  expiresAt: number;
  status: 'running' | 'exited';
  pid?: number;
  hostname?: string | null;
  configHash?: string;
  version?: string;
}

export interface RunnerLeaseInput {
  client: RtdbClient;
  runnerPath: string;
  identity: RunnerIdentity;
  ownerId: string;
  ttlSeconds: number;
  instancesPath: string;
  logger: Logger;
  version?: string;
}

export interface RunnerLease {
  identity: RunnerIdentity;
  recordPath: string;
  generation: number;
  stop(): Promise<void>;
  update(patch: Partial<RunnerRecord>): Promise<void>;
  onLost(callback: (record: RunnerRecord | null) => void): void;
}

export async function createRunnerLease(input: RunnerLeaseInput): Promise<RunnerLease> {
  const recordPath = `${input.runnerPath}/${sanitizeRtdbKey(input.identity.key)}`;
  const claim = await claimRunnerRecord(input, recordPath);
  const lease: RunnerLease = {
    identity: input.identity,
    recordPath,
    generation: claim.record?.generation ?? 1,
    stop: () => Promise.resolve(),
    update: async () => undefined,
    onLost: () => undefined,
  };
  const lostCallbacks: Array<(record: RunnerRecord | null) => void> = [];
  let lost = false;
  const heartbeatIntervalMs = Math.max(1_000, Math.floor((input.ttlSeconds * 1_000) / 3));
  const timer = setInterval(() => {
    if (lost) return;
    void refreshRunnerRecord(input, recordPath)
      .catch((error) => input.logger.warn({ error: toPublicError(error) }, 'runner.heartbeat_failed'));
  }, heartbeatIntervalMs);
  timer.unref();

  const unsubscribe = input.client.watchValue<RunnerRecord>(recordPath, (value) => {
    if (lost) return;
    if (!value || value.ownerId !== input.ownerId || value.generation !== lease.generation) {
      lost = true;
      input.logger.warn(
        { key: input.identity.key, previousOwner: value?.ownerId, newGeneration: value?.generation },
        'runner.ownership_lost',
      );
      for (const callback of lostCallbacks) callback(value);
    }
  });

  lease.stop = async () => {
    clearInterval(timer);
    unsubscribe();
    if (lost) return;
    const result = await input.client.transaction<RunnerRecord>(recordPath, (current) => {
      if (!current || current.ownerId !== input.ownerId) return undefined;
      return { ...current, status: 'exited', heartbeatAt: Date.now() };
    });
    if (!result.committed) {
      input.logger.warn({ key: input.identity.key }, 'runner.stop_record_not_owned');
    }
  };
  lease.update = async (patch) => {
    if (lost) return;
    const result = await input.client.transaction<RunnerRecord>(recordPath, (current) => {
      if (!current || current.ownerId !== input.ownerId) return undefined;
      return { ...current, ...patch, heartbeatAt: Date.now() };
    });
    if (!result.committed) {
      input.logger.warn({ key: input.identity.key }, 'runner.update_record_not_owned');
    }
  };
  lease.onLost = (callback) => {
    lostCallbacks.push(callback);
  };
  return lease;
}

async function claimRunnerRecord(
  input: RunnerLeaseInput,
  recordPath: string,
): Promise<{ record: RunnerRecord | null }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const now = Date.now();
    const current = await input.client.get<RunnerRecord>(recordPath);
    if (current && current.ownerId === input.ownerId) {
      const refreshed = await input.client.transaction<RunnerRecord>(recordPath, (value) => {
        if (!value || value.ownerId !== input.ownerId) return undefined;
        return { ...value, heartbeatAt: now, expiresAt: now + input.ttlSeconds * 1_000, status: 'running' };
      });
      if (refreshed.committed) return { record: refreshed.snapshot };
      continue;
    }
    const result = await input.client.transaction<RunnerRecord>(recordPath, (value) => ({
      key: input.identity.key,
      provider: input.identity.provider,
      owner: input.identity.owner,
      repo: input.identity.repo,
      ...(input.identity.workflowFile ? { workflowFile: input.identity.workflowFile } : {}),
      generation: (value?.generation ?? 0) + 1,
      ownerId: input.ownerId,
      claimedAt: now,
      heartbeatAt: now,
      expiresAt: now + input.ttlSeconds * 1_000,
      status: 'running',
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? null,
      ...(input.version ? { version: input.version } : {}),
      ...(value?.configHash ? { configHash: value.configHash } : {}),
    }));
    if (result.committed) return { record: result.snapshot };
  }
  throw new AppError('RUNNER_CLAIM_CONFLICT', `Unable to claim runner ${input.identity.key} after 10 attempts.`, {
    retryable: true,
  });
}

async function refreshRunnerRecord(input: RunnerLeaseInput, recordPath: string): Promise<void> {
  const now = Date.now();
  const result = await input.client.transaction<RunnerRecord>(recordPath, (value) => {
    if (!value || value.ownerId !== input.ownerId) return undefined;
    return { ...value, heartbeatAt: now, expiresAt: now + input.ttlSeconds * 1_000 };
  });
  if (!result.committed) {
    throw new AppError('RUNNER_HEARTBEAT_LOST', `Runner ${input.identity.key} no longer owns its record.`);
  }
}