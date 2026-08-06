import type { PublicError } from '../types.js';
import { redactSecrets } from './logger.js';

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      context?: Record<string, unknown>;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
    this.status = options.status;
  }
}

export class ConfigValidationError extends AppError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super('CONFIG_INVALID', `Configuration is invalid:\n${issues.map((item) => `- ${item}`).join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export function toAppError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(fallbackCode, redactSecrets(error.message), { cause: error });
  }
  return new AppError(fallbackCode, redactSecrets(String(error)));
}

export function toPublicError(error: unknown): PublicError {
  const appError = toAppError(error);
  const publicError: PublicError = {
    code: appError.code,
    message: redactSecrets(appError.message),
    retryable: appError.retryable,
  };
  if (Object.keys(appError.context).length > 0) {
    publicError.context = sanitizeObject(appError.context) as Record<string, unknown>;
  }
  return publicError;
}

export function sanitizeError(error: unknown): Error {
  const appError = toAppError(error);
  return new AppError(appError.code, redactSecrets(appError.message), {
    retryable: appError.retryable,
    context: sanitizeObject(appError.context) as Record<string, unknown>,
    status: appError.status,
  });
}

function sanitizeObject(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        /token|secret|authorization|credential|password/i.test(key) ? key : key,
        /token|secret|authorization|credential|password/i.test(key) ? '[REDACTED]' : sanitizeObject(item),
      ]),
    );
  }
  return value;
}
