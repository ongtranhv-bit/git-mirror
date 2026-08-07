import type { RtdbClient } from '../rtdb/client.js';

export interface RotationLockRecord {
  owner: string;
  rotationKey: string;
  claimedAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export async function acquireRotationLock(client: RtdbClient, path: string, owner: string, rotationKey: string, ttlSeconds: number): Promise<boolean> {
  const now = Date.now();
  const result = await client.transaction<RotationLockRecord>(path, (current) => {
    if (current && current.expiresAt >= now && current.owner !== owner) return undefined;
    return { owner, rotationKey, claimedAt: current?.owner === owner ? current.claimedAt : now, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000 };
  });
  return result.committed;
}

export async function refreshRotationLock(client: RtdbClient, path: string, owner: string, ttlSeconds: number): Promise<boolean> {
  const now = Date.now();
  const result = await client.transaction<RotationLockRecord>(path, (current) => {
    if (!current || current.owner !== owner) return undefined;
    return { ...current, heartbeatAt: now, expiresAt: now + ttlSeconds * 1_000 };
  });
  return result.committed;
}

export async function releaseRotationLock(client: RtdbClient, path: string, owner: string): Promise<void> {
  await client.transaction<RotationLockRecord>(path, (current) => {
    if (!current || current.owner !== owner) return undefined;
    return null;
  });
}
