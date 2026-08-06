import type { RuntimeConfig } from '../types.js';

const TOKEN_PATTERNS = [
  /(Authorization\s*:\s*)(?:Bearer|Basic|token)\s+[^\s"']+/gi,
  /([?&](?:auth|access_token|token|pat)=)[^&\s]+/gi,
  /((?:token|pat|secret|password)["']?\s*[:=]\s*["'])[^"']+/gi,
  /(https?:\/\/)[^/@\s]+@/gi,
];

const SECRET_VALUES = new Set<string>();

export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 4) SECRET_VALUES.add(secret);
}

export function redactSecrets(input: string): string {
  let output = input;
  for (const secret of SECRET_VALUES) output = output.split(secret).join('[REDACTED]');
  output = output.replace(TOKEN_PATTERNS[0]!, '$1[REDACTED]');
  output = output.replace(TOKEN_PATTERNS[1]!, '$1[REDACTED]');
  output = output.replace(TOKEN_PATTERNS[2]!, '$1[REDACTED]');
  output = output.replace(TOKEN_PATTERNS[3]!, '$1[REDACTED]@');
  return output;
}

export type LogLevel = RuntimeConfig['logLevel'];
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
  function write(logLevel: LogLevel, context: Record<string, unknown>, message: string): void {
    if (LEVELS[logLevel] < LEVELS[level]) return;
    const record = sanitize({
      level: logLevel,
      time: new Date().toISOString(),
      ...base,
      ...context,
      msg: message,
    });
    const line = JSON.stringify(record);
    (logLevel === 'error' ? console.error : console.log)(line);
  }

  return {
    debug: (context, message) => write('debug', context, message),
    info: (context, message) => write('info', context, message),
    warn: (context, message) => write('warn', context, message),
    error: (context, message) => write('error', context, message),
    child: (context) => createLogger(level, { ...base, ...context }),
  };
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|authorization|credential|password|raw/i.test(key) ? '[REDACTED]' : sanitize(item),
      ]),
    );
  }
  return value;
}
