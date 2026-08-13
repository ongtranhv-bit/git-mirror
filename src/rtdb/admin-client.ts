import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { createLogger, type Logger } from '../shared/logger.js';
import type { RtdbClient, TransactionResult } from './client.js';
import { RestRtdbClient } from './rest-client.js';
import { createServiceAccountTokenProvider } from './token.js';

type FirebaseDatabase = import('firebase-admin/database').Database;
type DataSnapshot = import('firebase-admin/database').DataSnapshot;

const APP_NAME = 'git-mirror-admin';

export class AdminRtdbClient implements RtdbClient {
  private readonly rest: RtdbClient;
  private readonly database: FirebaseDatabase;
  private readonly prefix: string;
  private readonly logger: Logger;

  constructor(database: FirebaseDatabase, prefix: string, rest: RtdbClient, logger?: Logger) {
    this.database = database;
    this.prefix = prefix;
    this.rest = rest;
    this.logger = logger ?? createLogger('warn', { service: 'rtdb-admin' });
  }

  async get<T>(path: string): Promise<T | null> {
    return this.rest.get<T>(path);
  }

  async set(path: string, value: unknown): Promise<void> {
    await this.rest.set(path, value);
  }

  async update(values: Record<string, unknown>): Promise<void> {
    await this.rest.update(values);
  }

  async remove(path: string): Promise<void> {
    await this.rest.remove(path);
  }

  async transaction<T>(
    path: string,
    updater: (current: T | null) => T | null | undefined,
  ): Promise<TransactionResult<T>> {
    return this.rest.transaction<T>(path, updater);
  }

  onChildAdded<T>(path: string, callback: (key: string, value: T) => void | Promise<void>): () => void {
    const ref = this.database.ref(joinPath(this.prefix, path));
    const listener = (snapshot: DataSnapshot): void => {
      const value = snapshot.val() as T;
      if (value === null || value === undefined) return;
      const key = snapshot.key ?? '';
      void Promise.resolve(callback(key, value)).catch((error) => {
        this.logger.error(
          { path, key, error: error instanceof Error ? error.message : String(error) },
          'rtdb.child_added_failed',
        );
      });
    };
    ref.on('child_added', listener);
    return () => ref.off('child_added', listener);
  }

  watchValue<T>(path: string, callback: (value: T | null) => void | Promise<void>): () => void {
    const ref = this.database.ref(joinPath(this.prefix, path));
    const listener = (snapshot: DataSnapshot): void => {
      const value = snapshot.val() as T | null;
      void Promise.resolve(callback(value === undefined ? null : value)).catch((error) => {
        this.logger.error(
          { path, error: error instanceof Error ? error.message : String(error) },
          'rtdb.value_changed_failed',
        );
      });
    };
    ref.on('value', listener);
    return () => ref.off('value', listener);
  }
}

export async function createAdminRtdbClient(
  databaseUrl: string,
  serviceAccountJson: string,
): Promise<RtdbClient | null> {
  let serviceAccount: ServiceAccountJson;
  try {
    serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccountJson;
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error('Service account requires client_email and private_key.');
    }
  } catch (error) {
    throw new AppError(
      'SERVICE_ACCOUNT_INVALID',
      'GOOGLE_SERVICE_ACCOUNT_B64 is not a valid service account.',
      { cause: error },
    );
  }
  try {
    const credential = {
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key,
    };
    const [{ initializeApp, cert, getApps }, { getDatabase }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/database'),
    ]);
    const { rootUrl, prefix } = splitDatabaseUrl(databaseUrl);
    const adminApp =
      getApps().find((item) => item.name === APP_NAME) ??
      initializeApp({ credential: cert(credential), databaseURL: rootUrl }, APP_NAME);
    const database = getDatabase(adminApp);
    const rest = new RestRtdbClient(
      databaseUrl,
      createServiceAccountTokenProvider(Buffer.from(serviceAccountJson, 'utf8').toString('base64')),
    );
    return new AdminRtdbClient(database, prefix, rest);
  } catch (error) {
    return null;
  }
}

function splitDatabaseUrl(databaseUrl: string): { rootUrl: string; prefix: string } {
  const url = new URL(databaseUrl);
  const prefix = url.pathname.replace(/^\/+|\/+$/g, '');
  url.pathname = '';
  url.search = '';
  return { rootUrl: url.toString().replace(/\/$/, ''), prefix };
}

function joinPath(prefix: string, path: string): string {
  const normalized = path.replace(/^\/+/, '');
  return prefix ? `${prefix}/${normalized}` : normalized;
}

interface ServiceAccountJson {
  project_id?: string;
  client_email: string;
  private_key: string;
}