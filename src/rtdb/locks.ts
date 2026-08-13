import type { RtdbClient } from './client.js';
import { sanitizeRtdbKey } from '../shared/paths.js';

export interface LockRecord {
  owner: string;
  claimedAt: number;
  expiresAt: number;
  heartbeatAt: number;
}

export function heartbeatIntervalMs(ttlSeconds: number): number {
  return Math.max(1_000, Math.floor((ttlSeconds * 1_000) / 3));
}

export function isLockStale(lock: LockRecord, ttlSeconds: number, now: number = Date.now()): boolean {
  const lastSeenAt = Number(lock.heartbeatAt ?? lock.claimedAt);
  return now - lastSeenAt > 2 * heartbeatIntervalMs(ttlSeconds);
}

export async function isInstanceAlive(
  client: RtdbClient,
  instancesPath: string,
  instanceId: string,
  now: number = Date.now(),
  graceMs = 90_000,
): Promise<boolean> {
  const record = await client.get<{ status?: string; heartbeatAt?: number }>(`${instancesPath}/${instanceId}`);
  if (!record) return false;
  if (record.status !== 'running') return false;
  return now - Number(record.heartbeatAt ?? 0) <= graceMs;
}

export interface ReclaimOptions {
  instancesPath?: string;
}

async function shouldReclaim(
  client: RtdbClient,
  current: LockRecord | null | undefined,
  owner: string,
  ttlSeconds: number,
  now: number,
  options: ReclaimOptions = {},
): Promise<boolean> {
  if (!current || current.owner === owner) return true;
  const expired = Number(current.expiresAt) < now;
  if (expired) return true;
  if (options.instancesPath) return !(await isInstanceAlive(client, options.instancesPath, current.owner, now));
  return isLockStale(current, ttlSeconds, now);
}

export async function claimEventAtomically(
  client: RtdbClient,
  processingPath: string,
  eventId: string,
  owner: string,
  ttlSeconds: number,
  payload: unknown,
  options: ReclaimOptions = {},
): Promise<boolean> {
  const now = Date.now();
  const read = await client.get<Record<string, unknown> & LockRecord>(`${processingPath}/${eventId}`);
  const reclaimOwner = read && read.owner !== owner ? await shouldReclaim(client, read, owner, ttlSeconds, now, options) : false;
  const result = await client.transaction<Record<string, unknown> & LockRecord>(`${processingPath}/${eventId}`, (current) => {
    if (current && current.owner !== owner) {
      if (current.owner === read?.owner) {
        if (!reclaimOwner) return undefined;
      } else if (!shouldReclaimSync(current, ttlSeconds, now)) {
        return undefined;
      }
    }
    return { owner, claimedAt: now, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000, payload };
  });
  return result.committed;
}

function shouldReclaimSync(current: LockRecord, ttlSeconds: number, now: number): boolean {
  return Number(current.expiresAt) < now || isLockStale(current, ttlSeconds, now);
}

export async function acquireDestinationLock(
  client: RtdbClient,
  locksPath: string,
  lockKey: string,
  owner: string,
  ttlSeconds: number,
  options: ReclaimOptions = {},
): Promise<boolean> {
  const now = Date.now();
  const path = `${locksPath}/${sanitizeRtdbKey(lockKey)}`;
  const read = await client.get<LockRecord>(path);
  const reclaimOwner = read && read.owner !== owner ? await shouldReclaim(client, read, owner, ttlSeconds, now, options) : false;
  const result = await client.transaction<LockRecord>(path, (current) => {
    if (current && current.owner !== owner) {
      if (current.owner === read?.owner) {
        if (!reclaimOwner) return undefined;
      } else if (!shouldReclaimSync(current, ttlSeconds, now)) {
        return undefined;
      }
    }
    return { owner, claimedAt: current?.claimedAt ?? now, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000 };
  });
  return result.committed;
}

export async function refreshLock(
  client: RtdbClient,
  lockPath: string,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const result = await client.transaction<LockRecord>(lockPath, (current) => {
    if (!current || current.owner !== owner) return undefined;
    return { ...current, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000 };
  });
  return result.committed;
}

export async function releaseDestinationLock(
  client: RtdbClient,
  locksPath: string,
  lockKey: string,
  owner: string,
): Promise<void> {
  await client.transaction<LockRecord>(`${locksPath}/${sanitizeRtdbKey(lockKey)}`, (current) => {
    if (!current || current.owner !== owner) return undefined;
    return null;
  });
}
