import { readFile } from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import type { AppConfig } from '../types.js';
import type { RtdbClient } from '../rtdb/client.js';
import { interpolateEnvironment } from './resolve-env.js';
import { parseConfig } from './schema.js';
import { parseFilterRulesFromEnv } from '../filter.js';

export interface LoadConfigOptions {
  raw?: string;
  file?: string;
  rtdb?: RtdbClient;
  rtdbPath?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const raw = options.raw ?? env.CONFIG_JSON;
  const file = options.file ?? env.CONFIG_FILE;
  let source: string;

  if (raw) {
    source = decodeRawConfig(raw);
  } else if (file) {
    source = await readFile(file, 'utf8');
  } else if (options.rtdb) {
    const value = await options.rtdb.get<string>(options.rtdbPath ?? env.RTDB_CONFIG_PATH ?? '/sync/config');
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError('CONFIG_NOT_FOUND', 'RTDB config node does not contain a base64 JSON string.');
    }
    source = decodeBase64(value);
  } else {
    throw new AppError(
      'CONFIG_NOT_FOUND',
      'No configuration found. Provide --config-json, CONFIG_JSON, --config/CONFIG_FILE, or RTDB credentials.',
    );
  }

  return parseRawConfig(source, env);
}

export function loadRawConfig(raw: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseRawConfig(decodeRawConfig(raw), env);
}

export function encodeConfig(rawJson: string): string {
  JSON.parse(rawJson);
  return Buffer.from(rawJson, 'utf8').toString('base64');
}

export function decodeBase64(value: string): string {
  try {
    const decoded = Buffer.from(value.trim(), 'base64').toString('utf8');
    JSON.parse(decoded);
    return decoded;
  } catch (error) {
    throw new AppError('CONFIG_BASE64_INVALID', 'Config value is not valid base64-encoded JSON.', { cause: error });
  }
}

function decodeRawConfig(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  return decodeBase64(trimmed);
}

function parseRawConfig(source: string, env: NodeJS.ProcessEnv): AppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AppError('CONFIG_JSON_INVALID', 'Configuration is not valid JSON.', { cause: error });
  }
  const config = parseConfig(interpolateEnvironment(parsed, env));
  const envRules = parseFilterRulesFromEnv(env.SRC_FILTER_COMMIT_EXCLUDE);
  if (envRules.length > 0) {
    const existing = config.src.filter?.commit?.exclude ?? [];
    config.src.filter = { commit: { exclude: [...existing, ...envRules] } };
  }
  const envRetention = Number(env.RTDB_RETENTION_DAYS);
  if (Number.isFinite(envRetention) && envRetention > 0) {
    config.rtdb.retentionDays = envRetention;
  }
  if (env.CODESPACE_KEEPALIVE_ENABLED !== undefined) {
    const value = env.CODESPACE_KEEPALIVE_ENABLED.trim().toLowerCase();
    config.runtime.codespaceKeepalive.enabled = value === '1' || value === 'true' || value === 'yes';
  }
  const envKeepaliveInterval = Number(env.CODESPACE_KEEPALIVE_INTERVAL_MINUTES);
  if (Number.isFinite(envKeepaliveInterval) && envKeepaliveInterval > 0) {
    config.runtime.codespaceKeepalive.intervalMinutes = envKeepaliveInterval;
  }
  return config;
}
