import { ensureRemote } from '../git/workspace.js';
import { pushMirror } from '../git/mirror.js';
import type { DestinationConfig, DestinationResult, RemoteRepository, SourceRepository } from '../types.js';

export async function syncOneToOne(input: {
  destinationId: string;
  destination: DestinationConfig;
  repository: RemoteRepository;
  source: SourceRepository;
  sourceWorkspace: string;
  timeoutMs: number;
  dryRun: boolean;
}): Promise<DestinationResult> {
  const startedAt = Date.now();
  const remoteName = `dst-${input.destinationId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  await ensureRemote(input.sourceWorkspace, remoteName, input.repository.cloneUrl, input.timeoutMs);
  if (!input.dryRun) {
    await pushMirror(
      input.sourceWorkspace,
      remoteName,
      input.destination.creds,
      input.destination.push,
      input.timeoutMs,
    );
  }
  return {
    destinationId: input.destinationId,
    provider: input.destination.type,
    mode: 'one-to-one',
    repo: input.repository.repo,
    sourceSha: input.source.sha,
    destinationSha: input.source.sha,
    status: input.dryRun ? 'dry-run' : 'synced',
    durationMs: Date.now() - startedAt,
  };
}
