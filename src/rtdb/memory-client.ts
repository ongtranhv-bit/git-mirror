import type { RtdbClient, TransactionResult } from './client.js';

export class MemoryRtdbClient implements RtdbClient {
  private data: Record<string, unknown> = {};
  private listeners = new Map<string, Set<(key: string, value: unknown) => void | Promise<void>>>();
  private valueListeners = new Map<string, Set<(value: unknown) => void | Promise<void>>>();
  private transactionChain: Promise<void> = Promise.resolve();

  async get<T>(path: string): Promise<T | null> {
    const value = getAt(this.data, segments(path));
    return value === undefined ? null : structuredClone(value as T);
  }

  async set(path: string, value: unknown): Promise<void> {
    const parts = segments(path);
    const key = parts.at(-1) ?? '';
    const parentPath = `/${parts.slice(0, -1).join('/')}`;
    setAt(this.data, parts, structuredClone(value));
    await this.emit(parentPath, key, value);
  }

  async update(values: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(values)) {
      if (value === null) deleteAt(this.data, segments(path));
      else setAt(this.data, segments(path), structuredClone(value));
      const parts = segments(path);
      await this.emit(`/${parts.slice(0, -1).join('/')}`, parts.at(-1) ?? '', value);
    }
  }

  async remove(path: string): Promise<void> {
    const parts = segments(path);
    deleteAt(this.data, parts);
    await this.emit(`/${parts.slice(0, -1).join('/')}`, parts.at(-1) ?? '', null);
  }

  async transaction<T>(
    path: string,
    updater: (current: T | null) => T | null | undefined,
  ): Promise<TransactionResult<T>> {
    let result: TransactionResult<T> = { committed: false, snapshot: null };
    this.transactionChain = this.transactionChain.then(async () => {
      const current = await this.get<T>(path);
      const next = updater(current);
      if (next === undefined) {
        result = { committed: false, snapshot: current };
        return;
      }
      await this.set(path, next);
      result = { committed: true, snapshot: structuredClone(next) };
    });
    await this.transactionChain;
    return result;
  }

  onChildAdded<T>(path: string, callback: (key: string, value: T) => void | Promise<void>): () => void {
    const normalized = normalize(path);
    const callbacks = this.listeners.get(normalized) ?? new Set();
    callbacks.add(callback as (key: string, value: unknown) => void | Promise<void>);
    this.listeners.set(normalized, callbacks);
    void this.get<Record<string, T>>(path).then(async (existing) => {
      for (const [key, value] of Object.entries(existing ?? {})) await callback(key, value);
    });
    return () => callbacks.delete(callback as (key: string, value: unknown) => void | Promise<void>);
  }

  watchValue<T>(path: string, callback: (value: T | null) => void | Promise<void>): () => void {
    const normalized = normalize(path);
    const callbacks = this.valueListeners.get(normalized) ?? new Set();
    callbacks.add(callback as (value: unknown) => void | Promise<void>);
    this.valueListeners.set(normalized, callbacks);
    void this.get<T>(path).then((existing) => callback(existing));
    return () => callbacks.delete(callback as (value: unknown) => void | Promise<void>);
  }

  private async emit(parentPath: string, key: string, value: unknown): Promise<void> {
    if (value !== null) {
      for (const callback of this.listeners.get(normalize(parentPath)) ?? []) await callback(key, structuredClone(value));
    }
    const changed = normalize(`${parentPath}/${key}`);
    for (const [watched, callbacks] of this.valueListeners) {
      if (changed === watched || changed.startsWith(`${watched}/`)) {
        const current = await this.get(watched);
        for (const callback of callbacks) await callback(current);
      }
    }
  }
}

function normalize(path: string): string {
  return `/${segments(path).join('/')}`;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function getAt(root: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setAt(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  if (parts.length === 0) {
    Object.keys(root).forEach((key) => delete root[key]);
    if (value && typeof value === 'object') Object.assign(root, value);
  } else current[parts.at(-1) ?? ''] = value;
}

function deleteAt(root: Record<string, unknown>, parts: string[]): void {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object') return;
    current = next as Record<string, unknown>;
  }
  delete current[parts.at(-1) ?? ''];
}
