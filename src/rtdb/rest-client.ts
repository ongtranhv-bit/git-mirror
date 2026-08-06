import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../shared/errors.js';
import type { RtdbClient, TransactionResult } from './client.js';

export interface AuthTokenProvider {
  getQueryAuth(): Promise<string | undefined>;
  getBearerToken(): Promise<string | undefined>;
}

export class RestRtdbClient implements RtdbClient {
  private readonly baseUrl: string;
  private readonly auth: AuthTokenProvider;

  constructor(databaseUrl: string, auth: AuthTokenProvider) {
    this.baseUrl = databaseUrl.replace(/\/$/, '');
    this.auth = auth;
  }

  async get<T>(path: string): Promise<T | null> {
    const response = await this.request(path, { method: 'GET' });
    return (await response.json()) as T | null;
  }

  async set(path: string, value: unknown): Promise<void> {
    await this.request(path, { method: 'PUT', body: JSON.stringify(value) });
  }

  async update(values: Record<string, unknown>): Promise<void> {
    const normalized = Object.fromEntries(Object.entries(values).map(([path, value]) => [normalizePath(path), value]));
    await this.request('/', { method: 'PATCH', body: JSON.stringify(normalized) });
  }

  async remove(path: string): Promise<void> {
    await this.request(path, { method: 'DELETE' });
  }

  async transaction<T>(
    path: string,
    updater: (current: T | null) => T | null | undefined,
  ): Promise<TransactionResult<T>> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const getResponse = await this.request(path, {
        method: 'GET',
        headers: { 'X-Firebase-ETag': 'true' },
      });
      const etag = getResponse.headers.get('etag');
      if (!etag) throw new AppError('RTDB_ETAG_MISSING', 'RTDB transaction response did not include an ETag.');
      const current = (await getResponse.json()) as T | null;
      const next = updater(current);
      if (next === undefined) return { committed: false, snapshot: current };
      const putResponse = await this.request(path, {
        method: 'PUT',
        headers: { 'If-Match': etag },
        body: JSON.stringify(next),
        allowStatus: [200, 412],
      });
      if (putResponse.status === 200) return { committed: true, snapshot: next };
      await delay(Math.min(25 * 2 ** attempt, 500));
    }
    throw new AppError('RTDB_TRANSACTION_CONFLICT', `RTDB transaction repeatedly conflicted at ${path}.`, {
      retryable: true,
    });
  }

  onChildAdded<T>(path: string, callback: (key: string, value: T) => void | Promise<void>): () => void {
    const controller = new AbortController();
    void this.sseLoop(path, callback, controller.signal);
    return () => controller.abort();
  }

  private async sseLoop<T>(
    path: string,
    callback: (key: string, value: T) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const known = new Set<string>();
    while (!signal.aborted) {
      try {
        const headers = await this.headers({ Accept: 'text/event-stream' });
        const response = await fetch(await this.url(path), { headers, signal });
        if (!response.ok || !response.body) {
          throw new AppError('RTDB_SSE_FAILED', `RTDB SSE returned HTTP ${response.status}.`, {
            status: response.status,
            retryable: response.status >= 500,
          });
        }
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = '';
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            await this.handleSseBlock(block, known, callback);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof AppError && !error.retryable) throw error;
        await delay(1_000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private async handleSseBlock<T>(
    block: string,
    known: Set<string>,
    callback: (key: string, value: T) => void | Promise<void>,
  ): Promise<void> {
    const event = block
      .split('\n')
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    const dataText = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('');
    if (!dataText || event === 'keep-alive' || event === 'cancel' || event === 'auth_revoked') return;
    const envelope = JSON.parse(dataText) as { path: string; data: unknown };
    if (envelope.path === '/' && envelope.data && typeof envelope.data === 'object') {
      for (const [key, value] of Object.entries(envelope.data as Record<string, T>)) {
        if (value === null) known.delete(key);
        else if (!known.has(key)) {
          known.add(key);
          await callback(key, value);
        }
      }
      return;
    }
    const key = envelope.path.replace(/^\//, '').split('/')[0];
    if (!key) return;
    if (envelope.data === null) known.delete(key);
    else if (!known.has(key)) {
      known.add(key);
      await callback(key, envelope.data as T);
    }
  }

  private async request(
    path: string,
    options: RequestInit & { allowStatus?: number[] } = {},
  ): Promise<Response> {
    const headers = await this.headers({ 'Content-Type': 'application/json', ...(options.headers ?? {}) });
    const response = await fetch(await this.url(path), { ...options, headers });
    const allowed = options.allowStatus ?? [200];
    if (!allowed.includes(response.status)) {
      const text = await response.text();
      throw new AppError('RTDB_HTTP_ERROR', `RTDB returned HTTP ${response.status}: ${text}`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 408 || response.status === 429,
        context: { path: normalizePath(path) },
      });
    }
    return response;
  }

  private async headers(initial: HeadersInit): Promise<Headers> {
    const headers = new Headers(initial);
    const bearer = await this.auth.getBearerToken();
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    return headers;
  }

  private async url(path: string): Promise<string> {
    const auth = await this.auth.getQueryAuth();
    const url = new URL(`${this.baseUrl}/${normalizePath(path)}.json`);
    if (auth) url.searchParams.set('auth', auth);
    return url.toString();
  }
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}
