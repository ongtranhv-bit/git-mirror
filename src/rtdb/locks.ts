import type { RtdbClient } from './client.js';
import { sanitizeRtdbKey } from '../shared/paths.js';

export interface LockRecord {
  owner: string;
  claimedAt: number;
  expiresAt: number;
  heartbeatAt: number;
}

export async function claimEventAtomically(
  client: RtdbClient,
  processingPath: string,
  eventId: string,
  owner: string,
  ttlSeconds: number,
  payload: unknown,
): Promise<boolean> {
  const now = Date.now();
  const result = await client.transaction<Record<string, unknown> & LockRecord>(`${processingPath}/${eventId}`, (current) => {
    if (current && Number(current.expiresAt) >= now && current.owner !== owner) return undefined;
    return { owner, claimedAt: now, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000, payload };
  });
  return result.committed;
}

export async function acquireDestinationLock(
  client: RtdbClient,
  locksPath: string,
  lockKey: string,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const result = await client.transaction<LockRecord>(`${locksPath}/${sanitizeRtdbKey(lockKey)}`, (current) => {
    if (current && current.expiresAt >= now && current.owner !== owner) return undefined;
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
