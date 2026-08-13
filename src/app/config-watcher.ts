import { createHash } from 'node:crypto';
import type { Logger } from '../shared/logger.js';
import { AppError, toPublicError } from '../shared/errors.js';
import type { RtdbClient } from '../rtdb/client.js';
import type { AppConfig } from '../types.js';
import { decodeBase64, parseConfigSource } from '../config/load.js';
import { LiveConfig } from '../config/live.js';

export const RESTART_REQUIRED_KEYS: ReadonlyArray<string> = ['runtime.workdir'];

export interface ConfigReloadInput {
  client: RtdbClient;
  rtdbPath: string;
  env?: NodeJS.ProcessEnv;
  live: LiveConfig;
  logger: Logger;
  /** Path where rejected config snapshots are recorded, e.g. `${statePath}/config-errors`. */
  errorPath?: string;
  enabled?: boolean;
  onApplied?: (previous: AppConfig, next: AppConfig) => void | Promise<void>;
  onRejected?: (error: AppError, raw: unknown) => void | Promise<void>;
  onRestartRequired?: (reason: string) => void | Promise<void>;
}

export interface ConfigReloadHandle {
  stop(): void;
  idle(): Promise<void>;
}

export function watchConfigReload(input: ConfigReloadInput): ConfigReloadHandle {
  if (input.enabled === false) {
    input.logger.info({}, 'config.reload_disabled');
    return { stop: () => {}, idle: async () => undefined };
  }
  let chain = Promise.resolve();
  const unsubscribe = input.client.watchValue<string>(input.rtdbPath, (value) => {
    chain = chain.then(() => reloadConfig(input, value)).catch((error) => {
      input.logger.error({ error: toPublicError(error) }, 'config.reload_loop_failed');
    });
  });
  return {
    stop: () => unsubscribe(),
    idle: () => chain,
  };
}

async function reloadConfig(input: ConfigReloadInput, value: string | null): Promise<void> {
  if (typeof value !== 'string' || !value.trim()) {
    await reject(input, new AppError('CONFIG_RELOAD_EMPTY', 'RTDB config node became empty; keeping the active config.'), value);
    return;
  }
  let next: AppConfig;
  try {
    next = parseConfigSource(decodeBase64(value), input.env ?? process.env);
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('CONFIG_RELOAD_FAILED', error instanceof Error ? error.message : String(error));
    await reject(input, appError, value);
    return;
  }

  const previous = input.live.get();
  const restartChanges = RESTART_REQUIRED_KEYS.filter((key) => getPath(previous, key) !== getPath(next, key));
  if (restartChanges.length > 0) {
    const reason = `Config change requires restart: ${restartChanges.join(', ')}`;
    input.logger.warn({ changes: restartChanges, configHash: configHashOf(next) }, 'config.restart_required');
    await input.onRestartRequired?.(reason);
    return;
  }

  input.live.swap(next);
  input.logger.info(
    { configHash: configHashOf(next), configVersion: next.configVersion, destinations: Object.keys(next.dest) },
    'config.reloaded',
  );
  await input.onApplied?.(previous, next);
}

async function reject(input: ConfigReloadInput, error: AppError, raw: unknown): Promise<void> {
  input.logger.warn({ error: toPublicError(error) }, 'config.reload_rejected');
  if (input.errorPath) {
    try {
      await input.client.set(`${input.errorPath}/${Date.now()}`, {
        error: toPublicError(error),
        rawHash: raw === null ? 'null' : typeof raw === 'string' ? hashOf(raw) : 'unknown',
        rejectedAt: Date.now(),
      });
    } catch (writeError) {
      input.logger.warn({ error: toPublicError(writeError) }, 'config.reload_error_write_failed');
    }
  }
  await input.onRejected?.(error, raw);
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function configHashOf(config: AppConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 24);
}
