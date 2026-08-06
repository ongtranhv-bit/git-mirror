import { cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CommitConfig, CredentialConfig, SourceRepository } from '../types.js';
import { resolveInside } from '../shared/paths.js';
import { getHeadSha, runGit } from './workspace.js';

export interface DirectorySyncInput {
  destinationWorkspace: string;
  sourceWorktree: string;
  source: SourceRepository;
  sourceSubject: string;
  directory: string;
  branch: string;
  credential: CredentialConfig;
  commit: CommitConfig;
  instanceId: string;
  timeoutMs: number;
  dryRun: boolean;
}

export interface DirectorySyncOutput {
  status: 'synced' | 'skipped' | 'dry-run';
  destinationSha?: string;
  message: string;
}

export async function syncDirectory(input: DirectorySyncInput): Promise<DirectorySyncOutput> {
  if (await hasSourceCommitMarker(input.destinationWorkspace, input.source.sha, input.directory, input.timeoutMs)) {
    return {
      status: 'skipped',
      destinationSha: await getHeadSha(input.destinationWorkspace, input.timeoutMs),
      message: 'Source commit marker already exists.',
    };
  }

  const target = resolveInside(input.destinationWorkspace, input.directory);
  await removeStaleFiles(target);
  await mkdir(target, { recursive: true });
  await cp(input.sourceWorktree, target, {
    recursive: true,
    force: true,
    filter: (source) => basename(source) !== '.git',
  });
  await stageDirectoryChanges(input.destinationWorkspace, input.directory, input.timeoutMs);
  const diff = await runGit(['diff', '--cached', '--quiet', '--', input.directory], {
    cwd: input.destinationWorkspace,
    timeoutMs: input.timeoutMs,
    allowFailure: true,
  });
  if (diff.exitCode === 0) {
    return {
      status: 'skipped',
      destinationSha: await getHeadSha(input.destinationWorkspace, input.timeoutMs),
      message: 'Destination directory already matches source tree.',
    };
  }

  const message = buildSyncCommitMessage({
    commit: input.commit,
    source: input.source,
    sourceSubject: input.sourceSubject,
    sourceDirectory: input.directory,
    instanceId: input.instanceId,
    timestamp: new Date().toISOString(),
  });
  if (input.dryRun) {
    await runGit(['reset'], { cwd: input.destinationWorkspace, timeoutMs: input.timeoutMs });
    return { status: 'dry-run', message };
  }

  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: input.commit.authorName,
    GIT_AUTHOR_EMAIL: input.commit.authorEmail,
    GIT_COMMITTER_NAME: input.commit.committerName,
    GIT_COMMITTER_EMAIL: input.commit.committerEmail,
  };
  await runGit(['commit', '--file=-'], {
    cwd: input.destinationWorkspace,
    timeoutMs: input.timeoutMs,
    input: `${message}\n`,
    env: commitEnv,
  });
  const sha = await getHeadSha(input.destinationWorkspace, input.timeoutMs);
  await runGit(['push', 'origin', `HEAD:refs/heads/${input.branch}`], {
    cwd: input.destinationWorkspace,
    credential: input.credential,
    timeoutMs: input.timeoutMs,
  });
  return { status: 'synced', destinationSha: sha, message };
}

export async function removeStaleFiles(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export async function stageDirectoryChanges(workspace: string, directory: string, timeoutMs: number): Promise<void> {
  await runGit(['add', '-A', '--', directory], { cwd: workspace, timeoutMs });
}

export async function hasSourceCommitMarker(
  workspace: string,
  sourceSha: string,
  directory: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runGit(['log', '-n', '200', '--format=%B%x00', '--', directory], {
    cwd: workspace,
    timeoutMs,
    allowFailure: true,
  });
  return result.stdout.includes(`Source-Commit: ${sourceSha}`);
}

export function buildSyncCommitMessage(input: {
  commit: CommitConfig;
  source: SourceRepository;
  sourceSubject: string;
  sourceDirectory: string;
  instanceId: string;
  timestamp: string;
}): string {
  const values: Record<string, string> = {
    prefix: input.commit.messagePrefix,
    sourceOwner: input.source.owner,
    sourceRepo: input.source.repo,
    sourceRef: input.source.ref,
    sourceBranch: input.source.ref.replace(/^refs\/heads\//, ''),
    sourceSha: input.source.sha,
    sourceShortSha: input.source.sha.slice(0, 12),
    sourceSubject: input.sourceSubject,
    sourceAuthor: input.commit.authorName,
    sourceDirectory: input.sourceDirectory,
    timestamp: input.timestamp,
    instanceId: input.instanceId,
  };
  const subject = renderTemplate(input.commit.template, values).trim();
  const trailers = Object.entries(input.commit.trailers)
    .map(([key, template]) => `${key}: ${renderTemplate(template, values)}`)
    .join('\n');
  return `${subject}\n\n${trailers}`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
}
