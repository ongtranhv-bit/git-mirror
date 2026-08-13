import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../shared/logger.js';
import { toPublicError } from '../shared/errors.js';
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
import { startCodespaceKeepalive } from './keepalive.js';
import { shouldPublishRuntimeStatus, startRuntimeStatus } from '../codespace/runtime-status.js';
import { createShutdownController } from './shutdown.js';
import { bridgeOnce, bridgePendingEvents } from '../webhook/github-bridge.js';

async function runRecoveryLoop(input: {
  options: EventProcessorOptions;
  config: AppConfig;
  bridge?: boolean;
  logger: Logger;
}): Promise<void> {
  const recovered = await recoverExpiredJobs(input.options.client, input.config.rtdb);
  if (recovered > 0) input.logger.info({ recovered }, 'event.reaper_recovered');
  const pending = await processAllPending(input.options);
  if (pending > 0) input.logger.info({ pending }, 'event.reaper_pending_processed');
  if (input.bridge) {
    const caughtUp = await bridgeOnce({
      client: input.options.client,
      config: input.config,
      logger: input.logger,
      webhookPath: process.env.WEBHOOK_PATH ?? input.config.rtdb.webhookPath,
    });
    if (caughtUp.processed > 0) input.logger.info({ processed: caughtUp.processed }, 'event.reaper_bridge_processed');
  }
}

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
  bridge?: boolean;
}): Promise<{ processed: number; instanceId: string }> {
  const instanceId = resolveInstanceId(input.instanceId);
  let currentEvent: string | undefined;
  const runtimeStatus = shouldPublishRuntimeStatus() ? startRuntimeStatus({
    client: input.client,
    instanceId,
    intervalSeconds: input.config.runtime.heartbeatSeconds,
    currentEvent: () => currentEvent,
  }) : undefined;
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
    maxEventRetries: input.config.runtime.maxEventRetries,
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

  let listener: ReturnType<typeof listenPendingEvents> | undefined;
  let bridge: ReturnType<typeof bridgePendingEvents> | undefined;
  let shutdown: ReturnType<typeof createShutdownController> | undefined;
  let keepalive: ReturnType<typeof startCodespaceKeepalive> | undefined;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let cleaner: ReturnType<typeof setInterval> | undefined;
  try {
    await recoverExpiredJobs(input.client, input.config.rtdb);
    await cleanupOldEvents(input.client, input.config.rtdb, input.config.rtdb.retentionDays);
    const caughtUp = await processAllPending(options);
    if (caughtUp > 0) input.logger.info({ processed: caughtUp }, 'event.catchup_done');
    if (input.once) return { processed: caughtUp, instanceId };

    listener = listenPendingEvents(options);
    if (input.bridge) {
      const webhookOptions = {
        client: input.client,
        config: input.config,
        logger: input.logger,
        webhookPath: process.env.WEBHOOK_PATH ?? input.config.rtdb.webhookPath,
      };
      const bridgeCaughtUp = await bridgeOnce(webhookOptions);
      input.logger.info({ processed: bridgeCaughtUp.processed, skipped: bridgeCaughtUp.skipped }, 'bridge.catchup_done');
      bridge = bridgePendingEvents(webhookOptions);
      input.logger.info({}, 'bridge.started');
    }
    if (runtimeStatus) {
      try { await runtimeStatus.markReady(); } catch (error) { input.logger.warn({ error: toPublicError(error) }, 'codespace.runtime_status_ready_failed'); }
    }
    shutdown = createShutdownController();
    keepalive = startCodespaceKeepalive({ config: input.config.runtime.codespaceKeepalive, logger: input.logger });
    reaper = setInterval(
      () => void runRecoveryLoop({ options, config: input.config, bridge: input.bridge, logger: input.logger })
        .catch((error) => input.logger.warn({ error: toPublicError(error) }, 'event.reaper_failed')),
      Math.max(5_000, input.config.runtime.heartbeatSeconds * 1_000),
    );
    reaper.unref();
    cleaner = setInterval(
      () => void cleanupOldEvents(input.client, input.config.rtdb, input.config.rtdb.retentionDays)
        .catch((error) => input.logger.warn({ error: toPublicError(error) }, 'event.cleanup_failed')),
      Math.max(60_000, 6 * 60 * 60 * 1_000),
    );
    cleaner.unref();
    await shutdown.wait();
    return { processed: caughtUp, instanceId };
  } finally {
    bridge?.stop();
    if (bridge) {
      try { await bridge.idle(); } catch (error) { input.logger.warn({ error: toPublicError(error) }, 'bridge.shutdown_failed'); }
    }
    listener?.stop();
    if (listener) {
      try { await listener.idle(); } catch (error) { input.logger.warn({ error: toPublicError(error) }, 'event.listener_shutdown_failed'); }
    }
    if (reaper) clearInterval(reaper);
    if (cleaner) clearInterval(cleaner);
    keepalive?.stop();
    if (runtimeStatus) {
      try { await runtimeStatus.stop(); } catch (error) { input.logger.warn({ error: toPublicError(error) }, 'codespace.runtime_status_stop_failed'); }
    }
    try { await stopHeartbeat(); } catch (error) { input.logger.warn({ error: toPublicError(error) }, 'instance.heartbeat_stop_failed'); }
    shutdown?.dispose();
  }
}
