import type { Logger } from '../shared/logger.js';
import { toAppError, toPublicError } from '../shared/errors.js';
import { isRetryableError } from '../shared/retry.js';
import type { HookEvent, SyncEventResult } from '../types.js';
import type { RtdbClient } from './client.js';
import { claimEventAtomically, refreshLock } from './locks.js';

export interface EventPaths {
  pendingPath: string;
  processingPath: string;
  processedPath: string;
  failedPath: string;
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

async function requeueEvent(client: RtdbClient, paths: EventPaths, eventId: string, payload: unknown): Promise<void> {
  await client.update({
    [`${paths.pendingPath}/${eventId}`]: payload,
    [`${paths.processingPath}/${eventId}`]: null,
  });
}

export async function processPendingEvent(
  eventId: string,
  payload: Omit<HookEvent, 'eventId'> | HookEvent,
  options: EventProcessorOptions,
): Promise<boolean> {
  const claimed = await claimEventAtomically(
    options.client,
    options.paths.processingPath,
    eventId,
    options.instanceId,
    options.lockTtlSeconds,
    payload,
  );
  if (!claimed) return false;

  const heartbeat = setInterval(
    () => void refreshLock(options.client, `${options.paths.processingPath}/${eventId}`, options.instanceId, options.lockTtlSeconds),
    Math.max(1_000, Math.floor((options.lockTtlSeconds * 1_000) / 3)),
  );
  heartbeat.unref();
  const event: HookEvent = { ...payload, eventId } as HookEvent;
  const log = options.logger.child({ eventId, instanceId: options.instanceId });
  log.info({}, 'event.claimed');
  try {
    const result = await options.handler(event);
    await markProcessed(options.client, options.paths, eventId, result);
    log.info({ durationMs: result.completedAt - result.startedAt }, 'event.processed');
  } catch (error) {
    const attempts = attemptsOf(payload);
    if (attempts < options.maxEventRetries && isRetryableError(error)) {
      await requeueEvent(options.client, options.paths, eventId, { ...payload, _retries: attempts + 1 });
      log.warn({ attempts: attempts + 1, maxAttempts: options.maxEventRetries }, 'event.retryable_requeued');
      return true;
    }
    const aggregateResult = extractAggregateResult(error);
    await markFailed(options.client, options.paths, eventId, payload, error, aggregateResult);
    log.error({ error: toPublicError(error) }, 'event.failed');
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function listenPendingEvents(options: EventProcessorOptions): {
  stop: () => void;
  idle: () => Promise<void>;
} {
  let accepting = true;
  let chain = Promise.resolve();
  const unsubscribe = options.client.onChildAdded<Omit<HookEvent, 'eventId'>>(options.paths.pendingPath, (eventId, payload) => {
    if (!accepting) return;
    chain = chain
      .then(() => processPendingEvent(eventId, payload, options))
      .then(() => undefined)
      .catch((error) => {
        options.logger.error({ eventId, error: toPublicError(error) }, 'event.queue_error');
      });
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
    [`${paths.processingPath}/${eventId}`]: null,
  });
}

export async function recoverExpiredJobs(client: RtdbClient, paths: EventPaths, now = Date.now()): Promise<number> {
  const processing =
    (await client.get<Record<string, { expiresAt?: number; payload?: Omit<HookEvent, 'eventId'> }>>(paths.processingPath)) ?? {};
  let recovered = 0;
  for (const [eventId, record] of Object.entries(processing)) {
    if (!record.payload || (record.expiresAt ?? Number.POSITIVE_INFINITY) >= now) continue;
    const pending = await client.get(`${paths.pendingPath}/${eventId}`);
    const updates: Record<string, unknown> = { [`${paths.processingPath}/${eventId}`]: null };
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
  return removed;
}

export async function markProcessed(
  client: RtdbClient,
  paths: EventPaths,
  eventId: string,
  result: SyncEventResult,
): Promise<void> {
  await client.update({
    [`${paths.processedPath}/${eventId}`]: result,
    [`${paths.pendingPath}/${eventId}`]: null,
    [`${paths.processingPath}/${eventId}`]: null,
    [`${paths.failedPath}/${eventId}`]: null,
  });
}

export async function markFailed(
  client: RtdbClient,
  paths: EventPaths,
  eventId: string,
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
    [`${paths.processingPath}/${eventId}`]: null,
  });
}

function extractAggregateResult(error: unknown): SyncEventResult | undefined {
  if (error && typeof error === 'object' && 'result' in error) return (error as { result?: SyncEventResult }).result;
  return undefined;
}
