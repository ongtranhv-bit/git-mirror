import { setTimeout as delay } from 'node:timers/promises';
import { AppError, toAppError } from './errors.js';

export function isRetryableError(error: unknown): boolean {
  const appError = toAppError(error);
  if (appError.status === 401 || appError.status === 403) return false;
  if (/CONFIG_|PATH_TRAVERSAL|PERMISSION/i.test(appError.code)) return false;
  return appError.retryable || (appError.status !== undefined && appError.status >= 500);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { retries: number; backoffMs: number; onRetry?: (error: AppError, attempt: number) => void },
): Promise<T> {
  let lastError: AppError | undefined;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = toAppError(error);
      if (attempt >= options.retries || !isRetryableError(lastError)) throw lastError;
      options.onRetry?.(lastError, attempt + 1);
      const jitter = Math.floor(Math.random() * Math.max(1, options.backoffMs / 5));
      await delay(options.backoffMs * 2 ** attempt + jitter);
    }
  }
  throw lastError ?? new AppError('RETRY_FAILED', 'Retry operation failed without an error.');
}
