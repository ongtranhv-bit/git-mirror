import { AppError } from '../shared/errors.js';
import { registerSecret } from '../shared/logger.js';
import { createAdminRtdbClient } from './admin-client.js';
import { RestRtdbClient, type AuthTokenProvider } from './rest-client.js';
import { createServiceAccountTokenProvider } from './token.js';

export interface TransactionResult<T> {
  committed: boolean;
  snapshot: T | null;
}

export interface RtdbClient {
  get<T>(path: string): Promise<T | null>;
  set(path: string, value: unknown): Promise<void>;
  update(values: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  transaction<T>(
    path: string,
    updater: (current: T | null) => T | null | undefined,
  ): Promise<TransactionResult<T>>;
  onChildAdded<T>(path: string, callback: (key: string, value: T) => void | Promise<void>): () => void;
  watchValue<T>(path: string, callback: (value: T | null) => void | Promise<void>): () => void;
  close?(): Promise<void> | void;
}

export async function createRtdbClientFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RtdbClient> {
  const databaseUrl = env.RTDB_URL;
  if (!databaseUrl) throw new AppError('RTDB_URL_MISSING', 'RTDB_URL is required for RTDB commands.');
  if (env.GOOGLE_SERVICE_ACCOUNT_B64) {
    const adminClient = await createAdminRtdbClient(databaseUrl, Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    if (adminClient) return adminClient;
    return new RestRtdbClient(databaseUrl, createServiceAccountTokenProvider(env.GOOGLE_SERVICE_ACCOUNT_B64));
  }
  if (env.RTDB_AUTH_SECRET) {
    registerSecret(env.RTDB_AUTH_SECRET);
    return new RestRtdbClient(databaseUrl, {
      getQueryAuth: async () => env.RTDB_AUTH_SECRET ?? '',
      getBearerToken: async () => undefined,
    });
  }
  throw new AppError(
    'RTDB_AUTH_MISSING',
    'Set GOOGLE_SERVICE_ACCOUNT_B64 or RTDB_AUTH_SECRET. Raw JSON validation does not require RTDB credentials.',
  );
}

export type { AuthTokenProvider };
export { createServiceAccountTokenProvider } from './token.js';