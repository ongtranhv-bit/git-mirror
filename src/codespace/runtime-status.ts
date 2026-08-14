import type { RtdbClient } from '../rtdb/client.js';
import { rotationPaths } from './state.js';
import type { RuntimeReadinessRecord } from './types.js';

export function shouldPublishRuntimeStatus(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODESPACES === 'true' && Boolean(env.CODESPACE_NAME?.trim());
}

export interface RuntimeStatusController {
  markReady(): Promise<void>;
  stop(): Promise<void>;
  reschedule(intervalSeconds: number): void;
}

export function startRuntimeStatus(input: {
  client: RtdbClient;
  path?: string;
  instanceId: string;
  intervalSeconds: number;
  currentEvent: () => string | undefined;
  metadata?: Partial<RuntimeReadinessRecord>;
}): RuntimeStatusController {
  const path = input.path ?? process.env.CODESPACE_READINESS_PATH ?? rotationPaths(process.env.CODESPACE_ROTATION_BASE_PATH).instances;
  let status: RuntimeReadinessRecord['status'] = 'starting';
  let readyAt: number | undefined;
  const startedAt = Date.now();
  let listenerAttached = false;
  const base = (): RuntimeReadinessRecord => ({
    instanceId: input.instanceId,
    codespaceName: input.metadata?.codespaceName ?? process.env.CODESPACE_NAME ?? 'not-a-codespace',
    status,
    ...(input.metadata?.repository ?? process.env.RUNTIME_REPOSITORY ? { repository: input.metadata?.repository ?? process.env.RUNTIME_REPOSITORY } : {}),
    ...(input.metadata?.branch ?? process.env.RUNTIME_BRANCH ? { branch: input.metadata?.branch ?? process.env.RUNTIME_BRANCH } : {}),
    ...(input.metadata?.runtimeCommitSha ?? process.env.RUNTIME_COMMIT_SHA ? { runtimeCommitSha: input.metadata?.runtimeCommitSha ?? process.env.RUNTIME_COMMIT_SHA } : {}),
    ...(input.metadata?.serviceVersion ?? process.env.RUNTIME_SERVICE_VERSION ?? process.env.npm_package_version ? { serviceVersion: input.metadata?.serviceVersion ?? process.env.RUNTIME_SERVICE_VERSION ?? process.env.npm_package_version } : {}),
    rtdbConnected: true,
    listenerAttached,
    startedAt,
    ...(readyAt !== undefined ? { readyAt } : {}),
    heartbeatAt: Date.now(),
    currentEvent: input.currentEvent() ?? null,
  });
  const write = async () => input.client.set(`${path}/${input.instanceId}`, base());
  void write().catch(() => undefined);
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    timer = setInterval(() => void write().catch(() => undefined), input.intervalSeconds * 1_000);
    timer.unref();
  };
  start();
  return {
    markReady: async () => {
      listenerAttached = true;
      status = 'ready';
      readyAt = Date.now();
      await write();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      status = 'stopped';
      listenerAttached = false;
      await write();
    },
    reschedule: (intervalSeconds: number) => {
      if (timer) clearInterval(timer);
      input.intervalSeconds = intervalSeconds;
      start();
    },
  };
}
