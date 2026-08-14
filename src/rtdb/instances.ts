import type { RtdbClient } from './client.js';

export interface HeartbeatHandle {
  (): Promise<void>;
  reschedule(intervalSeconds: number): void;
}

export function startHeartbeat(
  client: RtdbClient,
  instancesPath: string,
  instanceId: string,
  intervalSeconds: number,
  currentEvent: () => string | undefined,
  metadata?: () => Record<string, unknown>,
): HeartbeatHandle {
  const write = async (status: string) => {
    await client.set(`${instancesPath}/${instanceId}`, {
      instanceId,
      status,
      heartbeatAt: Date.now(),
      currentEvent: currentEvent() ?? null,
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? null,
      ...(metadata ? metadata() : {}),
    });
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    timer = setInterval(() => void write('running').catch(() => undefined), intervalSeconds * 1_000);
    timer.unref();
  };
  void write('running').catch(() => undefined);
  start();
  const stop = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await client.set(`${instancesPath}/${instanceId}`, {
      instanceId,
      status: 'stopped',
      stoppedAt: Date.now(),
      heartbeatAt: Date.now(),
      currentEvent: null,
    });
  };
  const handle = Object.assign(stop, {
    reschedule: (seconds: number) => {
      if (timer) clearInterval(timer);
      intervalSeconds = seconds;
      start();
    },
  }) as HeartbeatHandle;
  return handle;
}
