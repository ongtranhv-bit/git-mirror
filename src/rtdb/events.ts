import type { Logger } from '../shared/logger.js';
import { toPublicError } from '../shared/errors.js';
import { isRetryableError } from '../shared/retry.js';
import { sanitizeRtdbKey } from '../shared/paths.js';
import type { HookEvent, SyncEventResult } from '../types.js';
import type { RtdbClient } from './client.js';
import { claimEventAtomically, refreshLock } from './locks.js';

export interface EventPaths {
  pendingPath: string;
  processingPath: string;
  processedPath: string;
  failedPath: string;
  instancesPath: string;
  processedByCommitPath: string;
}

export interface EventProcessorOptions {
  client: RtdbClient;
  paths: EventPaths;
  instanceId: string;
  lockTtlSeconds: number;
  maxEventRetries: number;
  logger: Logger;
  handler: (event: HookEvent) => Promise<SyncEventResult>;
}

function attemptsOf(payload: unknown): number {
  return typeof payload === 'object' && payload !== null && Number.isFinite((payload as { _retries?: number })._retries)
    ? (payload as { _retries: number })._retries
    : 0;
}

export function commitKeyOf(payload: unknown): string {
  const after = (payload as { after?: string } | null)?.after;
  if (!after || !/^[0-9a-f]{7,64}$/i.test(after)) {
    const eventId = (payload as { _eventId?: string } | null)?._eventId ?? '';
    return eventId ? sanitizeRtdbKey(`event:${eventId}`) : sanitizeRtdbKey('event:unknown');
  }
  return sanitizeRtdbKey(`commit:${after}`);
}

async function requeueEvent(client: RtdbClient, paths: EventPaths, eventId: string, claimKey: string, payload: unknown): Promise<void> {
  await client.update({
    [`${paths.pendingPath}/${eventId}`]: payload,
    [`${paths.processingPath}/${claimKey}`]: null,
  });
}

export async function processPendingEvent(
  eventId: string,
  payload: Omit<HookEvent, 'eventId'> | HookEvent,
  options: EventProcessorOptions,
): Promise<boolean> {
  const claimKey = commitKeyOf(payload);
  const claimed = await claimEventAtomically(
    options.client,
    options.paths.processingPath,
    claimKey,
    options.instanceId,
    options.lockTtlSeconds,
    { ...payload, _eventId: eventId },
    { instancesPath: options.paths.instancesPath },
  );
  if (!claimed) return false;

  const event: HookEvent = { ...payload, eventId } as HookEvent;
  const log = options.logger.child({ eventId, instanceId: options.instanceId });
  const claimPath = `${options.paths.processingPath}/${claimKey}`;
  const heartbeat = setInterval(
    () => void refreshLock(options.client, claimPath, options.instanceId, options.lockTtlSeconds)
      .catch((error) => log.warn({ error: toPublicError(error) }, 'event.lock_heartbeat_failed')),
    Math.max(1_000, Math.floor((options.lockTtlSeconds * 1_000) / 3)),
  );
  heartbeat.unref();
  log.info({}, 'event.claimed');
  try {
    const alreadyProcessed = await isCommitProcessed(options.client, options.paths, claimKey);
    if (alreadyProcessed) {
      await options.client.update({
        [`${options.paths.pendingPath}/${eventId}`]: null,
        [`${options.paths.processingPath}/${claimKey}`]: null,
      });
      log.info({}, 'event.already_processed_skipped');
      return true;
    }
    if (await hasEarlierPendingSibling(options.client, options.paths, event)) {
      log.info({}, 'event.awaiting_earlier_sibling');
      await options.client.update({ [`${options.paths.processingPath}/${claimKey}`]: null });
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 100 * 2 ** Math.min(attemptsOf(payload), 5))));
      return processPendingEvent(eventId, payload, options);
    }
    const result = await options.handler(event);
    await markProcessed(options.client, options.paths, eventId, claimKey, result);
    log.info({ durationMs: result.completedAt - result.startedAt }, 'event.processed');
  } catch (error) {
    const attempts = attemptsOf(payload);
    if (attempts < options.maxEventRetries && isRetryableError(error)) {
      await requeueEvent(options.client, options.paths, eventId, claimKey, { ...payload, _retries: attempts + 1 });
      log.warn({ attempts: attempts + 1, maxAttempts: options.maxEventRetries }, 'event.retryable_requeued');
      return true;
    }
    const aggregateResult = extractAggregateResult(error);
    await markFailed(options.client, options.paths, eventId, claimKey, payload, error, aggregateResult);
    log.error({ error: toPublicError(error) }, 'event.failed');
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function isCommitProcessed(client: RtdbClient, paths: EventPaths, claimKey: string): Promise<boolean> {
  return (await client.get(`${paths.processedByCommitPath}/${claimKey}`)) !== null;
}

async function hasEarlierPendingSibling(
  client: RtdbClient,
  paths: EventPaths,
  event: HookEvent,
): Promise<boolean> {
  const [pending, processing] = await Promise.all([
    client.get<Record<string, Omit<HookEvent, 'eventId'> | undefined>>(paths.pendingPath),
    client.get<Record<string, { payload?: Omit<HookEvent, 'eventId'> }>>(paths.processingPath),
  ]);
  const candidates = [
    ...Object.values(pending ?? {}),
    ...Object.values(processing ?? {}).map((record) => record.payload),
  ].filter((item): item is Omit<HookEvent, 'eventId'> => Boolean(item));
  return candidates.some(
    (item) => item.repo === event.repo && item.ref === event.ref && (item.receivedAt ?? 0) < (event.receivedAt ?? 0),
  );
}

export function listenPendingEvents(options: EventProcessorOptions): {
  stop: () => void;
  idle: () => Promise<void>;
} {
  let accepting = true;
  let chain = Promise.resolve();
  const run = (eventId: string, payload: Omit<HookEvent, 'eventId'>, attempt: number): void => {
    chain = chain
      .then(() => processPendingEvent(eventId, payload, options))
      .then((claimed) => {
        if (claimed || !accepting) return;
        const delay = Math.min(5_000, 100 * 2 ** Math.min(attempt, 6));
        setTimeout(() => run(eventId, payload, attempt + 1), delay);
      })
      .catch((error) => {
        options.logger.error({ eventId, error: toPublicError(error) }, 'event.queue_error');
      });
  };
  const unsubscribe = options.client.onChildAdded<Omit<HookEvent, 'eventId'>>(options.paths.pendingPath, (eventId, payload) => {
    if (accepting) run(eventId, payload, 0);
  });
  return {
    stop: () => {
      accepting = false;
      unsubscribe();
    },
    idle: () => chain,
  };
}

export async function processAllPending(options: EventProcessorOptions): Promise<number> {
  const pending = (await options.client.get<Record<string, Omit<HookEvent, 'eventId'>>>(options.paths.pendingPath)) ?? {};
  const entries = Object.entries(pending).sort(([, left], [, right]) => (left.receivedAt ?? 0) - (right.receivedAt ?? 0));
  let count = 0;
  for (const [eventId, payload] of entries) {
    if (await processPendingEvent(eventId, payload, options)) count += 1;
  }
  return count;
}

export async function replayEvent(client: RtdbClient, paths: EventPaths, eventId: string): Promise<void> {
  const failed = await client.get<{ event?: Omit<HookEvent, 'eventId'> }>(`${paths.failedPath}/${eventId}`);
  if (!failed?.event) throw new Error(`Failed event ${eventId} was not found.`);
  await client.update({
    [`${paths.pendingPath}/${eventId}`]: failed.event,
    [`${paths.failedPath}/${eventId}`]: null,
  });
}

export async function recoverExpiredJobs(client: RtdbClient, paths: EventPaths, now = Date.now()): Promise<number> {
  const processing =
    (await client.get<Record<string, { expiresAt?: number; payload?: Omit<HookEvent, 'eventId'> & { _eventId?: string } }>>(
      paths.processingPath,
    )) ?? {};
  let recovered = 0;
  for (const [claimKey, record] of Object.entries(processing)) {
    if (!record.payload || (record.expiresAt ?? Number.POSITIVE_INFINITY) >= now) continue;
    const eventId = record.payload._eventId ?? claimKey;
    const pending = await client.get(`${paths.pendingPath}/${eventId}`);
    const updates: Record<string, unknown> = { [`${paths.processingPath}/${claimKey}`]: null };
    if (pending === null) updates[`${paths.pendingPath}/${eventId}`] = record.payload;
    await client.update(updates);
    recovered += 1;
  }
  return recovered;
}

export async function cleanupOldEvents(
  client: RtdbClient,
  paths: EventPaths,
  retentionDays: number,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - retentionDays * 86_400_000;
  let removed = 0;
  for (const path of [paths.processedPath, paths.failedPath]) {
    const entries = (await client.get<Record<string, { completedAt?: number; failedAt?: number }>>(path)) ?? {};
    for (const [eventId, value] of Object.entries(entries)) {
      const timestamp = value.completedAt ?? value.failedAt ?? now;
      if (timestamp < cutoff) {
        await client.remove(`${path}/${eventId}`);
        removed += 1;
      }
    }
  }
  const processedCommits =
    (await client.get<Record<string, { completedAt?: number }>>(paths.processedByCommitPath)) ?? {};
  for (const [commitKey, value] of Object.entries(processedCommits)) {
    if ((value.completedAt ?? now) < cutoff) {
      await client.remove(`${paths.processedByCommitPath}/${commitKey}`);
      removed += 1;
    }
  }
  return removed;
}

export async function markProcessed(
  client: RtdbClient,
  paths: EventPaths,
  eventId: string,
  claimKey: string,
  result: SyncEventResult,
): Promise<void> {
  await client.update({
    [`${paths.processedPath}/${eventId}`]: result,
    [`${paths.processedByCommitPath}/${claimKey}`]: { eventId, completedAt: result.completedAt },
    [`${paths.pendingPath}/${eventId}`]: null,
    [`${paths.processingPath}/${claimKey}`]: null,
    [`${paths.failedPath}/${eventId}`]: null,
  });
}

export async function markFailed(
  client: RtdbClient,
  paths: EventPaths,
  eventId: string,
  claimKey: string,
  event: unknown,
  error: unknown,
  result?: SyncEventResult,
): Promise<void> {
  await client.update({
    [`${paths.failedPath}/${eventId}`]: {
      event,
      error: toPublicError(error),
      result: result ?? null,
      failedAt: Date.now(),
    },
    [`${paths.pendingPath}/${eventId}`]: null,
    [`${paths.processingPath}/${claimKey}`]: null,
  });
}

function extractAggregateResult(error: unknown): SyncEventResult | undefined {
  if (error && typeof error === 'object' && 'result' in error) return (error as { result?: SyncEventResult }).result;
  return undefined;
}