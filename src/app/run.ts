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
import type { ProviderAdapter } from '../providers/provider.js';
import { startCodespaceKeepalive, type KeepaliveHandle } from './keepalive.js';
import { shouldPublishRuntimeStatus, startRuntimeStatus, type RuntimeStatusController } from '../codespace/runtime-status.js';
import { createShutdownController } from './shutdown.js';
import { bridgeOnce, bridgePendingEvents } from '../webhook/github-bridge.js';
import { LiveConfig } from '../config/live.js';
import { watchConfigReload, type ConfigReloadHandle } from './config-watcher.js';
import { resolveRunnerIdentity } from '../runner/identity.js';
import { createRunnerLease, type RunnerLease } from '../runner/registry.js';

async function runRecoveryLoop(input: {
  getConfig: () => AppConfig;
  options: EventProcessorOptions;
  bridge?: boolean;
  logger: Logger;
}): Promise<void> {
  const config = input.getConfig();
  const recovered = await recoverExpiredJobs(input.options.client, config.rtdb);
  if (recovered > 0) input.logger.info({ recovered }, 'event.reaper_recovered');
  const pending = await processAllPending(input.options);
  if (pending > 0) input.logger.info({ pending }, 'event.reaper_pending_processed');
  if (input.bridge) {
    const caughtUp = await bridgeOnce({
      client: input.options.client,
      config,
      logger: input.logger,
      webhookPath: process.env.WEBHOOK_PATH ?? config.rtdb.webhookPath,
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
  reloadConfig?: boolean;
  adapters?: Record<string, ProviderAdapter>;
}): Promise<{ processed: number; instanceId: string }> {
  const instanceId = resolveInstanceId(input.instanceId);
  const logger = input.logger;
  const live = new LiveConfig(input.config);
  let currentEvent: string | undefined;

  const options: EventProcessorOptions = {
    client: input.client,
    instanceId,
    logger,
    getConfig: () => live.get(),
    handler: async (event: HookEvent) => {
      currentEvent = event.eventId;
      try {
        return await processHookEvent({
          config: live.get(),
          hook: event,
          instanceId,
          logger,
          rtdb: input.client,
          dryRun: input.dryRun,
          ...(input.adapters ? { adapters: input.adapters } : {}),
        });
      } finally {
        currentEvent = undefined;
      }
    },
  };

  const shutdown = createShutdownController();

  let lease: RunnerLease | undefined;
  if (!input.once) {
    const identity = resolveRunnerIdentity();
    if (identity) {
      lease = await createRunnerLease({
        client: input.client,
        runnerPath: live.get().rtdb.runnerPath,
        identity,
        ownerId: instanceId,
        ttlSeconds: live.get().runtime.lockTtlSeconds,
        instancesPath: live.get().rtdb.instancesPath,
        logger,
        version: process.env.npm_package_version ?? 'dev',
      });
      logger.info({ key: identity.key, generation: lease.generation, provider: identity.provider }, 'runner.lease_claimed');
      lease.onLost(() => shutdown.trigger());
      await lease.update({ configHash: live.getSnapshot().configHash });
    }
  }
  if (shutdown.signal.aborted) {
    logger.info({}, 'runner.lease_lost_before_start');
    return { processed: 0, instanceId };
  }

  let stopHeartbeat: ReturnType<typeof startHeartbeat> | undefined;
  const startHeartbeatTimer = () => {
    const config = live.get();
    stopHeartbeat = startHeartbeat(
      input.client,
      config.rtdb.instancesPath,
      instanceId,
      config.runtime.heartbeatSeconds,
      () => currentEvent,
      () => ({
        configHash: live.getSnapshot().configHash,
        ...(lease ? { runnerKey: lease.identity.key, runnerGeneration: lease.generation } : {}),
      }),
    );
  };

  let runtimeStatus: RuntimeStatusController | undefined;
  const startRuntimeStatusTimer = () => {
    if (!shouldPublishRuntimeStatus()) return;
    runtimeStatus = startRuntimeStatus({
      client: input.client,
      instanceId,
      intervalSeconds: live.get().runtime.heartbeatSeconds,
      currentEvent: () => currentEvent,
    });
  };

  let listener: ReturnType<typeof listenPendingEvents> | undefined;
  let bridge: ReturnType<typeof bridgePendingEvents> | undefined;
  let keepalive: KeepaliveHandle | undefined;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let cleaner: ReturnType<typeof setInterval> | undefined;
  let configWatcher: ConfigReloadHandle | undefined;

  const startReaper = () => {
    if (reaper) clearInterval(reaper);
    reaper = setInterval(
      () => void runRecoveryLoop({ getConfig: () => live.get(), options, bridge: input.bridge, logger })
        .catch((error) => logger.warn({ error: toPublicError(error) }, 'event.reaper_failed')),
      Math.max(5_000, live.get().runtime.heartbeatSeconds * 1_000),
    );
    reaper.unref();
  };
  const startCleaner = () => {
    if (cleaner) clearInterval(cleaner);
    cleaner = setInterval(
      () => void cleanupOldEvents(input.client, live.get().rtdb, live.get().rtdb.retentionDays)
        .catch((error) => logger.warn({ error: toPublicError(error) }, 'event.cleanup_failed')),
      Math.max(60_000, 6 * 60 * 60 * 1_000),
    );
    cleaner.unref();
  };
  const startListener = () => {
    listener = listenPendingEvents(options);
  };
  const startKeepalive = () => {
    keepalive = startCodespaceKeepalive({ config: live.get().runtime.codespaceKeepalive, logger });
  };
  const startBridge = async () => {
    const config = live.get();
    const webhookOptions = {
      client: input.client,
      config,
      logger,
      webhookPath: process.env.WEBHOOK_PATH ?? config.rtdb.webhookPath,
    };
    const bridgeCaughtUp = await bridgeOnce(webhookOptions);
    logger.info({ processed: bridgeCaughtUp.processed, skipped: bridgeCaughtUp.skipped }, 'bridge.catchup_done');
    bridge = bridgePendingEvents(webhookOptions);
    logger.info({}, 'bridge.started');
  };
  const restartListener = async () => {
    const previous = listener;
    listener = undefined;
    previous?.stop();
    await previous?.idle();
    if (!shutdown.signal.aborted) startListener();
  };
  const restartBridge = async () => {
    const previous = bridge;
    bridge = undefined;
    previous?.stop();
    await previous?.idle();
    if (!shutdown.signal.aborted) await startBridge();
  };

  const applyRuntimeChanges = (previous: AppConfig, next: AppConfig): void | Promise<void> => {
    if (previous.runtime.heartbeatSeconds !== next.runtime.heartbeatSeconds) {
      logger.info({ from: previous.runtime.heartbeatSeconds, to: next.runtime.heartbeatSeconds }, 'config.heartbeat_rescheduled');
      stopHeartbeat?.reschedule(next.runtime.heartbeatSeconds);
      runtimeStatus?.reschedule(next.runtime.heartbeatSeconds);
      startReaper();
    }
    if (
      previous.runtime.codespaceKeepalive.enabled !== next.runtime.codespaceKeepalive.enabled
      || previous.runtime.codespaceKeepalive.intervalMinutes !== next.runtime.codespaceKeepalive.intervalMinutes
    ) {
      keepalive?.stop();
      startKeepalive();
    }
    if (previous.rtdb.pendingPath !== next.rtdb.pendingPath) {
      logger.info({ from: previous.rtdb.pendingPath, to: next.rtdb.pendingPath }, 'config.listener_reattached');
      return restartListener();
    }
    if (input.bridge && previous.rtdb.webhookPath !== next.rtdb.webhookPath) {
      logger.info({ from: previous.rtdb.webhookPath, to: next.rtdb.webhookPath }, 'config.bridge_reattached');
      return restartBridge();
    }
    return undefined;
  };

  try {
    await recoverExpiredJobs(input.client, live.get().rtdb);
    await cleanupOldEvents(input.client, live.get().rtdb, live.get().rtdb.retentionDays);
    const caughtUp = await processAllPending(options);
    if (caughtUp > 0) logger.info({ processed: caughtUp }, 'event.catchup_done');
    if (input.once) return { processed: caughtUp, instanceId };

    startHeartbeatTimer();
    startRuntimeStatusTimer();
    startListener();
    if (input.bridge) await startBridge();
    if (runtimeStatus) {
      try { await runtimeStatus.markReady(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'codespace.runtime_status_ready_failed'); }
    }
    startKeepalive();
    startReaper();
    startCleaner();
    if (input.reloadConfig !== false) {
      configWatcher = watchConfigReload({
        client: input.client,
        rtdbPath: live.get().rtdb.configPath,
        live,
        logger,
        errorPath: `${live.get().rtdb.statePath}/config-errors`,
        onApplied: async (previous, next) => {
          await lease?.update({ configHash: live.getSnapshot().configHash });
          await applyRuntimeChanges(previous, next);
        },
        onRestartRequired: async (reason) => {
          logger.warn({ reason }, 'config.restart_required_exit');
          shutdown.trigger();
        },
      });
      logger.info({ path: live.get().rtdb.configPath }, 'config.watch_started');
    }
    await shutdown.wait();
    return { processed: caughtUp, instanceId };
  } finally {
    configWatcher?.stop();
    try { await configWatcher?.idle(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'config.watch_shutdown_failed'); }
    bridge?.stop();
    if (bridge) {
      try { await bridge.idle(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'bridge.shutdown_failed'); }
    }
    listener?.stop();
    if (listener) {
      try { await listener.idle(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'event.listener_shutdown_failed'); }
    }
    if (reaper) clearInterval(reaper);
    if (cleaner) clearInterval(cleaner);
    keepalive?.stop();
    if (runtimeStatus) {
      try { await runtimeStatus.stop(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'codespace.runtime_status_stop_failed'); }
    }
    if (stopHeartbeat) {
      try { await stopHeartbeat(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'instance.heartbeat_stop_failed'); }
    }
    if (lease) {
      try { await lease.stop(); } catch (error) { logger.warn({ error: toPublicError(error) }, 'runner.lease_stop_failed'); }
    }
    shutdown.dispose();
  }
}