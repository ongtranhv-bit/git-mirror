import type { DestinationResult, RemoteRepository } from '../types.js';
import { sanitizeRtdbKey } from '../shared/paths.js';
import type { RtdbClient } from './client.js';

export async function saveSyncState(
  client: RtdbClient,
  statePath: string,
  destinationId: string,
  result: DestinationResult,
  eventId: string,
): Promise<void> {
  const key = sanitizeRtdbKey(`${destinationId}/${result.repo}/${result.directory ?? '-'}`);
  await client.set(`${statePath}/sync/${key}`, {
    destinationId,
    repo: result.repo,
    directory: result.directory ?? null,
    lastSourceSha: result.sourceSha,
    destinationSha: result.destinationSha ?? null,
    lastSyncedAt: Date.now(),
    eventId,
    status: result.status,
  });
}

export async function saveRepositoryState(
  client: RtdbClient,
  statePath: string,
  destinationId: string,
  repository: RemoteRepository,
): Promise<void> {
  const key = sanitizeRtdbKey(`${destinationId}/${repository.org}/${repository.project ?? '-'}/${repository.repo}`);
  await client.set(`${statePath}/repositories/${key}`, {
    destinationId,
    ...repository,
    checkedAt: Date.now(),
  });
}
