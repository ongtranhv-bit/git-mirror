import { syncDirectory } from '../git/directory-sync.js';
import {
  createDetachedWorktree,
  ensureDestinationWorkspace,
  getCommitInfo,
} from '../git/workspace.js';
import type {
  DestinationResult,
  ManyToOneDestination,
  RemoteRepository,
  SourceRepository,
} from '../types.js';

export async function syncManyToOne(input: {
  destinationId: string;
  destination: ManyToOneDestination;
  repository: RemoteRepository;
  source: SourceRepository;
  sourceWorkspace: string;
  directory: string;
  workdir: string;
  instanceId: string;
  timeoutMs: number;
  dryRun: boolean;
}): Promise<DestinationResult> {
  const startedAt = Date.now();
  const destinationWorkspace = await ensureDestinationWorkspace(
    input.repository.cloneUrl,
    input.destination.branch,
    input.destination.creds,
    input.workdir,
    input.timeoutMs,
  );
  const commitInfo = await getCommitInfo(input.sourceWorkspace, input.source.sha, input.timeoutMs);
  const worktree = await createDetachedWorktree(input.sourceWorkspace, input.source.sha, input.workdir, input.timeoutMs);
  try {
    const output = await syncDirectory({
      destinationWorkspace,
      sourceWorktree: worktree.path,
      source: input.source,
      commitInfo,
      directory: input.directory,
      branch: input.destination.branch,
      credential: input.destination.creds,
      commit: input.destination.commit,
      instanceId: input.instanceId,
      timeoutMs: input.timeoutMs,
      dryRun: input.dryRun,
    });
    return {
      destinationId: input.destinationId,
      provider: input.destination.type,
      mode: 'many-to-one',
      repo: input.repository.repo,
      directory: input.directory,
      sourceSha: input.source.sha,
      destinationSha: output.destinationSha,
      status: output.status,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await worktree.cleanup();
  }
}
