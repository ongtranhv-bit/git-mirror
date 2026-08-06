import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../shared/logger.js';
import type { AppConfig, HookEvent } from '../types.js';
import type { RtdbClient } from '../rtdb/client.js';
import {
  cleanupOldEvents,
  listenPendingEvents,
  processAllPending,
  recoverExpiredJobs,
  type EventProcessorOptions,
} from '../rtdb/events.js';
import { startHeartbeat } from '../rtdb/instances.js';
import { processHookEvent } from '../sync/router.js';
import { createShutdownController } from './shutdown.js';

export function createInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function resolveInstanceId(provided?: string): string {
  return provided?.trim() || process.env.INSTANCE_ID?.trim() || createInstanceId();
}

export async function runWorker(input: {
  config: AppConfig;
  client: RtdbClient;
  logger: Logger;
  instanceId?: string;
  once?: boolean;
  dryRun?: boolean;
}): Promise<{ processed: number; instanceId: string }> {
  const instanceId = resolveInstanceId(input.instanceId);
  let currentEvent: string | undefined;
  const stopHeartbeat = startHeartbeat(
    input.client,
    input.config.rtdb.instancesPath,
    instanceId,
    input.config.runtime.heartbeatSeconds,
    () => currentEvent,
  );
  const options: EventProcessorOptions = {
    client: input.client,
    paths: input.config.rtdb,
    instanceId,
    lockTtlSeconds: input.config.runtime.lockTtlSeconds,
    logger: input.logger,
    handler: async (event: HookEvent) => {
      currentEvent = event.eventId;
      try {
        return await processHookEvent({
          config: input.config,
          hook: event,
          instanceId,
          logger: input.logger,
          rtdb: input.client,
          dryRun: input.dryRun,
        });
      } finally {
        currentEvent = undefined;
      }
    },
  };

  await recoverExpiredJobs(input.client, input.config.rtdb);
  await cleanupOldEvents(input.client, input.config.rtdb, input.config.rtdb.retentionDays);
  if (input.once) {
    const processed = await processAllPending(options);
    await stopHeartbeat();
    return { processed, instanceId };
  }

  const listener = listenPendingEvents(options);
  const shutdown = createShutdownController();
  const reaper = setInterval(
    () => void recoverExpiredJobs(input.client, input.config.rtdb),
    Math.max(5_000, input.config.runtime.heartbeatSeconds * 1_000),
  );
  reaper.unref();
  await shutdown.wait();
  listener.stop();
  await listener.idle();
  clearInterval(reaper);
  await stopHeartbeat();
  shutdown.dispose();
  return { processed: 0, instanceId };
}
