export interface ShutdownController {
  signal: AbortSignal;
  wait(): Promise<NodeJS.Signals>;
  dispose(): void;
}

export function createShutdownController(): ShutdownController {
  const controller = new AbortController();
  let resolveSignal: (signal: NodeJS.Signals) => void = () => undefined;
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort();
        resolveSignal(signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    wait: () => promise,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
