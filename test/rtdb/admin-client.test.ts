import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminRtdbClient } from '../../src/rtdb/admin-client.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';

interface FakeDatabase {
  store: Map<string, unknown>;
  listeners: Map<string, Array<(snapshot: { key: string | null; val: () => unknown }) => void>>;
  set(path: string, value: unknown): Promise<void>;
  remove(path: string): Promise<void>;
  onChildAdded(path: string, listener: (snapshot: { key: string | null; val: () => unknown }) => void): () => void;
}

function createFakeDatabase(): FakeDatabase {
  const store = new Map<string, unknown>();
  const listeners = new Map<string, Array<(snapshot: { key: string | null; val: () => unknown }) => void>>();
  const norm = (path: string): string => path.replace(/^\/+|\/+$/g, '');
  const emit = (path: string, value: unknown): void => {
    const normalized = norm(path);
    for (const [listenPath, list] of listeners) {
      if (normalized.startsWith(`${listenPath}/`)) {
        const key = normalized.slice(listenPath.length + 1);
        for (const listener of list) listener({ key, val: () => value });
      }
    }
  };
  return {
    store,
    listeners,
    async set(path: string, value: unknown): Promise<void> {
      store.set(norm(path), value);
      emit(path, value);
    },
    async remove(path: string): Promise<void> {
      store.delete(norm(path));
      emit(path, null);
    },
    onChildAdded(path: string, listener: (snapshot: { key: string | null; val: () => unknown }) => void): () => void {
      const normalized = norm(path);
      const list = listeners.get(normalized) ?? [];
      list.push(listener);
      listeners.set(normalized, list);
      for (const [key, value] of store) {
        if (key.startsWith(`${normalized}/`)) listener({ key: key.slice(normalized.length + 1), val: () => value });
      }
      return () => {
        listeners.set(normalized, (listeners.get(normalized) ?? []).filter((item) => item !== listener));
      };
    },
  };
}

function createClient(db: FakeDatabase, prefix = ''): AdminRtdbClient {
  const ref = (path?: string) => {
    const normalized = (path ?? '').replace(/^\/+|\/+$/g, '');
    let unsubscribe: (() => void) | undefined;
    return {
      on: (event: string, listener: (snapshot: { key: string | null; val: () => unknown }) => void) => {
        assert.equal(event, 'child_added');
        unsubscribe = db.onChildAdded(normalized, listener);
        return unsubscribe;
      },
      off: () => {
        unsubscribe?.();
        unsubscribe = undefined;
      },
    };
  };
  return new AdminRtdbClient(
    { ref } as unknown as import('firebase-admin/database').Database,
    prefix,
    new MemoryRtdbClient(),
  );
}

test('admin client CRUD and transactions delegate to the REST transport', async () => {
  const db = createFakeDatabase();
  const client = createClient(db);
  await client.set('/a/b', { v: 1 });
  assert.deepEqual(await client.get<{ v: number }>('/a/b'), { v: 1 });
  await client.update({ '/a/c': 2 });
  assert.equal(await client.get<number>('/a/c'), 2);
  await client.remove('/a/b');
  assert.equal(await client.get('/a/b'), null);
  const result = await client.transaction<number>('/counter', (current) => (current ?? 0) + 1);
  assert.equal(result.committed, true);
  assert.equal(result.snapshot, 1);
  const aborted = await client.transaction<number>('/counter', () => undefined);
  assert.equal(aborted.committed, false);
  assert.equal(aborted.snapshot, 1);
});

test('admin client onChildAdded listens under the configured prefix', async () => {
  const db = createFakeDatabase();
  const client = createClient(db, 'config-code-dh-hospital');
  await db.set('config-code-dh-hospital/events/one', { id: 1 });
  const received: string[] = [];
  const off = client.onChildAdded<{ id: number }>('/events', (key) => { received.push(key); });
  assert.deepEqual(received, ['one']);
  await db.set('config-code-dh-hospital/events/two', { id: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(received, ['one', 'two']);
  off();
  await db.set('config-code-dh-hospital/events/three', { id: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(received, ['one', 'two']);
});