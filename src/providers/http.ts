import { AppError } from '../shared/errors.js';
import { redactSecrets } from '../shared/logger.js';

export async function requestJson<T>(
  url: string,
  options: RequestInit & { timeoutMs: number; expected?: number[] },
): Promise<{ status: number; body: T | null; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const expected = options.expected ?? [200];
    const text = await response.text();
    let body: T | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = null;
      }
    }
    if (!expected.includes(response.status)) {
      const retryAfterMs = retryDelayFromHeaders(response.headers);
      const rateLimited = response.status === 429
        || (response.status === 403 && (retryAfterMs !== undefined || response.headers.get('x-ratelimit-remaining') === '0'));
      throw new AppError('PROVIDER_HTTP_ERROR', `Provider API returned HTTP ${response.status}: ${redactSecrets(text)}`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 408 || rateLimited,
        context: {
          status: response.status,
          url: redactUrl(url),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    }
    return { status: response.status, body, headers: response.headers };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError('PROVIDER_TIMEOUT', `Provider API request timed out after ${options.timeoutMs}ms.`, {
        retryable: true,
        cause: error,
      });
    }
    throw new AppError('PROVIDER_NETWORK_ERROR', `Provider API request failed: ${redactSecrets(String(error))}`, {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function retryDelayFromHeaders(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0 && headers.get('x-ratelimit-remaining') === '0') {
    return Math.max(0, reset * 1_000 - Date.now());
  }
  return undefined;
}
