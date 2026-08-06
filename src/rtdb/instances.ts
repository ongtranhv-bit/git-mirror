import type { RtdbClient } from './client.js';

export function startHeartbeat(
  client: RtdbClient,
  instancesPath: string,
  instanceId: string,
  intervalSeconds: number,
  currentEvent: () => string | undefined,
): () => Promise<void> {
  const write = async (status: string) => {
    await client.set(`${instancesPath}/${instanceId}`, {
      instanceId,
      status,
      heartbeatAt: Date.now(),
      currentEvent: currentEvent() ?? null,
      pid: process.pid,
      hostname: process.env.HOSTNAME ?? null,
    });
  };
  void write('running');
  const timer = setInterval(() => void write('running'), intervalSeconds * 1_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await client.set(`${instancesPath}/${instanceId}`, {
      instanceId,
      status: 'stopped',
      stoppedAt: Date.now(),
      heartbeatAt: Date.now(),
      currentEvent: null,
    });
  };
}
