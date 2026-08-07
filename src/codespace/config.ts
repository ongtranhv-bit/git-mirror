import { readFile } from 'node:fs/promises';
import { AppError, ConfigValidationError } from '../shared/errors.js';
import { stableHash } from '../shared/paths.js';
import type { RtdbClient } from '../rtdb/client.js';
import type { RotationConfig, RotationDayConfig } from './types.js';

const DEFAULT_PATH = '/sync/codespace/config';

export interface LoadRotationConfigOptions {
  raw?: string;
  file?: string;
  rtdb?: RtdbClient;
  rtdbPath?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadRotationConfig(options: LoadRotationConfigOptions = {}): Promise<RotationConfig> {
  const env = options.env ?? process.env;
  let source: string | undefined = options.raw ?? env.CODESPACE_ROTATION_CONFIG_JSON;
  if (!source && (options.file ?? env.CODESPACE_ROTATION_CONFIG_FILE)) {
    source = await readFile(options.file ?? env.CODESPACE_ROTATION_CONFIG_FILE ?? '', 'utf8');
  }
  if (!source && options.rtdb) {
    const value = await options.rtdb.get<string>(options.rtdbPath ?? env.CODESPACE_ROTATION_CONFIG_PATH ?? DEFAULT_PATH);
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppError('CODESPACE_CONFIG_NOT_FOUND', 'Codespace rotation config is missing from RTDB.');
    }
    source = decodeMaybeBase64(value);
  }
  if (!source) throw new AppError('CODESPACE_CONFIG_NOT_FOUND', 'Provide rotation config by CLI/file/env or RTDB.');
  return parseRotationConfig(parseJson(decodeMaybeBase64(source)), env);
}

export function encodeRotationConfig(rawJson: string): string {
  JSON.parse(rawJson);
  return Buffer.from(rawJson, 'utf8').toString('base64');
}

export function rotationConfigHash(config: RotationConfig): string {
  return stableHash(JSON.stringify(config));
}

export function resolveRotationDay(config: RotationConfig, date = new Date()): { dayOfMonth: number; rotationKey: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const dayOfMonth = Number(day);
  if (!year || !month || !day || !Number.isInteger(dayOfMonth)) {
    throw new AppError('CODESPACE_DATE_RESOLUTION_FAILED', `Unable to resolve date in timezone ${config.timezone}.`);
  }
  return { dayOfMonth, rotationKey: `${year}-${month}-${day}` };
}

export function dateForRotationKey(config: RotationConfig, rotationKey: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rotationKey)) {
    throw new AppError('CODESPACE_DATE_INVALID', '--date must use YYYY-MM-DD.');
  }
  const [yearText, monthText, dayText] = rotationKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const pivot = new Date(Date.UTC(year, month - 1, day, 12));
  if (pivot.getUTCFullYear() !== year || pivot.getUTCMonth() !== month - 1 || pivot.getUTCDate() !== day) {
    throw new AppError('CODESPACE_DATE_INVALID', '--date is not a valid calendar date.');
  }
  // Search a bounded set of instants around UTC noon so the explicit calendar
  // key stays exact even in UTC+14 / UTC-12 and fractional-offset zones.
  for (let quarterHours = -64; quarterHours <= 64; quarterHours += 1) {
    const candidate = new Date(pivot.getTime() + quarterHours * 15 * 60_000);
    if (resolveRotationDay(config, candidate).rotationKey === rotationKey) return candidate;
  }
  throw new AppError('CODESPACE_DATE_RESOLUTION_FAILED', `Unable to represent ${rotationKey} in timezone ${config.timezone}.`);
}

export function resolveDayConfig(config: RotationConfig, dayOfMonth: number): RotationDayConfig {
  const day = config.days[String(dayOfMonth)];
  if (!day || !day.enabled) {
    throw new AppError('CODESPACE_DAY_DISABLED', `Codespace rotation is not enabled for day ${dayOfMonth}.`);
  }
  return day;
}

function parseRotationConfig(input: unknown, env: NodeJS.ProcessEnv): RotationConfig {
  const issues: string[] = [];
  const root = objectValue(input, '$', issues);
  const configVersion = integer(root?.configVersion, '$.configVersion', issues, 1, 1);
  const enabled = booleanValue(root?.enabled, '$.enabled', issues, true);
  const timezone = stringValue(root?.timezone, '$.timezone', issues, 'Asia/Ho_Chi_Minh');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    issues.push('$.timezone: invalid IANA timezone.');
  }
  const startAt = stringValue(root?.startAt, '$.startAt', issues, '23:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startAt)) issues.push('$.startAt: expected HH:mm.');

  const daysObject = objectValue(root?.days, '$.days', issues) ?? {};
  const days: Record<string, RotationDayConfig> = {};
  for (const [key, raw] of Object.entries(daysObject)) {
    const dayNumber = Number(key);
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) {
      issues.push(`$.days.${key}: day key must be 1..31.`);
      continue;
    }
    const item = objectValue(raw, `$.days.${key}`, issues);
    const account = objectValue(item?.codespaceAccount, `$.days.${key}.codespaceAccount`, issues);
    const expectedLogin = requiredString(account?.expectedLogin, `$.days.${key}.codespaceAccount.expectedLogin`, issues);
    const tokenEnv = requiredString(account?.tokenEnv, `$.days.${key}.codespaceAccount.tokenEnv`, issues);
    if (expectedLogin && tokenEnv) {
      days[key] = {
        enabled: booleanValue(item?.enabled, `$.days.${key}.enabled`, issues, true),
        codespaceAccount: { expectedLogin, tokenEnv },
      };
    }
  }
  if (Object.keys(days).length === 0) issues.push('$.days: at least one valid day is required.');

  const bootstrapObject = objectValue(root?.bootstrap, '$.bootstrap', issues);
  const owner = requiredString(bootstrapObject?.owner, '$.bootstrap.owner', issues);
  const repo = requiredString(bootstrapObject?.repo, '$.bootstrap.repo', issues);
  const branch = stringValue(bootstrapObject?.branch, '$.bootstrap.branch', issues, 'main');
  const machine = optionalString(bootstrapObject?.machine);
  const devcontainerPath = optionalString(bootstrapObject?.devcontainerPath);
  const idleTimeoutMinutes = optionalPositiveInteger(bootstrapObject?.idleTimeoutMinutes, '$.bootstrap.idleTimeoutMinutes', issues);
  const retentionPeriodDays = optionalPositiveInteger(bootstrapObject?.retentionPeriodDays, '$.bootstrap.retentionPeriodDays', issues);
  if (retentionPeriodDays !== undefined && retentionPeriodDays > 30) {
    issues.push('$.bootstrap.retentionPeriodDays: must be between 1 and 30 days (GitHub maximum is 43200 minutes).');
  }

  const runtimeObject = objectValue(root?.runtime, '$.runtime', issues);
  const runtime = {
    rotationLockTtlSeconds: positiveInteger(runtimeObject?.rotationLockTtlSeconds, '$.runtime.rotationLockTtlSeconds', issues, 900),
    healthPollSeconds: positiveInteger(runtimeObject?.healthPollSeconds, '$.runtime.healthPollSeconds', issues, 5),
    healthTimeoutSeconds: positiveInteger(runtimeObject?.healthTimeoutSeconds, '$.runtime.healthTimeoutSeconds', issues, 300),
    maxRetries: nonNegativeInteger(runtimeObject?.maxRetries, '$.runtime.maxRetries', issues, 2),
    retryBackoffMs: positiveInteger(runtimeObject?.retryBackoffMs, '$.runtime.retryBackoffMs', issues, 2_000),
    stabilizationSeconds: nonNegativeInteger(runtimeObject?.stabilizationSeconds, '$.runtime.stabilizationSeconds', issues, 15),
    stopOldAfterHealthy: booleanValue(runtimeObject?.stopOldAfterHealthy, '$.runtime.stopOldAfterHealthy', issues, true),
    deleteOldAfterStop: booleanValue(runtimeObject?.deleteOldAfterStop, '$.runtime.deleteOldAfterStop', issues, false),
  };

  const testingObject = objectValue(root?.testing, '$.testing', issues);
  const testing = {
    enabled: booleanValue(testingObject?.enabled, '$.testing.enabled', issues, false),
    useRealCodespace: booleanValue(testingObject?.useRealCodespace, '$.testing.useRealCodespace', issues, false),
    ...(testingObject?.tokenDay !== undefined
      ? { tokenDay: integer(testingObject.tokenDay, '$.testing.tokenDay', issues, 1, 1, 31) }
      : {}),
    stopOldAfterHealthy: booleanValue(testingObject?.stopOldAfterHealthy, '$.testing.stopOldAfterHealthy', issues, false),
  };
  if (testing.enabled && env.NODE_ENV === 'production' && env.CODESPACE_ALLOW_PRODUCTION_TESTING !== '1') {
    issues.push('$.testing.enabled: production rejects testing mode unless CODESPACE_ALLOW_PRODUCTION_TESTING=1.');
  }
  if (runtime.deleteOldAfterStop && !runtime.stopOldAfterHealthy) {
    issues.push('$.runtime.deleteOldAfterStop: requires stopOldAfterHealthy=true.');
  }

  if (issues.length > 0 || !root || !bootstrapObject || !owner || !repo) throw new ConfigValidationError(issues);
  return {
    configVersion,
    enabled,
    timezone,
    startAt,
    days,
    bootstrap: {
      owner,
      repo,
      branch,
      ...(machine ? { machine } : {}),
      ...(devcontainerPath ? { devcontainerPath } : {}),
      ...(idleTimeoutMinutes ? { idleTimeoutMinutes } : {}),
      ...(retentionPeriodDays ? { retentionPeriodDays } : {}),
    },
    runtime,
    testing,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new AppError('CODESPACE_CONFIG_JSON_INVALID', 'Codespace rotation config is not valid JSON.', { cause: error });
  }
}

function decodeMaybeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    JSON.parse(decoded);
    return decoded;
  } catch (error) {
    throw new AppError('CODESPACE_CONFIG_BASE64_INVALID', 'Codespace rotation config is not JSON or base64 JSON.', { cause: error });
  }
}

function objectValue(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path}: expected object.`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(`${path}: required non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function stringValue(value: unknown, path: string, issues: string[], fallback: string): string {
  if (value === undefined) return fallback;
  return requiredString(value, path, issues) ?? fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, path: string, issues: string[], fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.push(`${path}: expected boolean.`);
    return fallback;
  }
  return value;
}

function integer(value: unknown, path: string, issues: string[], fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    issues.push(`${path}: expected integer ${min}..${max}.`);
    return fallback;
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string, issues: string[], fallback: number): number {
  return integer(value, path, issues, fallback, 1);
}

function nonNegativeInteger(value: unknown, path: string, issues: string[], fallback: number): number {
  return integer(value, path, issues, fallback, 0);
}

function optionalPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, path, issues, 1);
}
