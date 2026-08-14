import { cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CommitConfig, CredentialConfig, SourceRepository } from '../types.js';
import { resolveInside } from '../shared/paths.js';
import { getHeadSha, runGit } from './workspace.js';
import type { CommitInfo } from './workspace.js';

export interface DirectorySyncInput {
  destinationWorkspace: string;
  sourceWorktree: string;
  source: SourceRepository;
  commitInfo: CommitInfo;
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
  if (await directoryTreeMatchesCommit(
    input.destinationWorkspace,
    input.sourceWorktree,
    'HEAD',
    input.directory,
    input.timeoutMs,
  )) {
    return {
      status: 'skipped',
      destinationSha: await getHeadSha(input.destinationWorkspace, input.timeoutMs),
      message: 'Destination directory tree already matches source tree.',
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
    commitInfo: input.commitInfo,
    sourceDirectory: input.directory,
    instanceId: input.instanceId,
    timestamp: new Date().toISOString(),
  });
  if (input.dryRun) {
    await runGit(['reset'], { cwd: input.destinationWorkspace, timeoutMs: input.timeoutMs });
    return { status: 'dry-run', message };
  }

  const commitValues: Record<string, string> = {
    sourceOwner: input.source.owner,
    sourceRepo: input.source.repo,
    sourceBranch: input.source.ref.replace(/^refs\/heads\//, ''),
    sourceSha: input.commitInfo.sha,
    sourceShortSha: input.commitInfo.shortSha,
    sourceSubject: input.commitInfo.subject,
    sourceBody: input.commitInfo.body,
    sourceAuthor: input.commitInfo.authorName,
    sourceAuthorEmail: input.commitInfo.authorEmail,
    sourceAuthorDate: input.commitInfo.authorDate,
    sourceCommitter: input.commitInfo.committerName,
    sourceCommitterEmail: input.commitInfo.committerEmail,
    sourceCommitterDate: input.commitInfo.committerDate,
    sourceDirectory: input.directory,
    instanceId: input.instanceId,
    timestamp: new Date().toISOString(),
  };
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: renderTemplate(input.commit.authorName, commitValues),
    GIT_AUTHOR_EMAIL: renderTemplate(input.commit.authorEmail, commitValues),
    GIT_COMMITTER_NAME: renderTemplate(input.commit.committerName, commitValues),
    GIT_COMMITTER_EMAIL: renderTemplate(input.commit.committerEmail, commitValues),
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
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  return { status: 'synced', destinationSha: sha, message };
}

export async function directoryTreeMatchesCommit(
  destinationWorkspace: string,
  sourceWorkspace: string,
  sourceCommit: string,
  directory: string,
  timeoutMs: number,
): Promise<boolean> {
  const sourceTree = await runGit(['rev-parse', `${sourceCommit}^{tree}`], {
    cwd: sourceWorkspace,
    timeoutMs,
    allowFailure: true,
  });
  if (sourceTree.exitCode !== 0) return false;
  const destinationTree = await runGit(['rev-parse', `HEAD:${directory}`], {
    cwd: destinationWorkspace,
    timeoutMs,
    allowFailure: true,
  });
  if (destinationTree.exitCode !== 0) return false;
  return sourceTree.stdout.trim() === destinationTree.stdout.trim();
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
  commitInfo: CommitInfo;
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
    sourceSha: input.commitInfo.sha,
    sourceShortSha: input.commitInfo.shortSha,
    sourceSubject: input.commitInfo.subject,
    sourceBody: input.commitInfo.body,
    sourceAuthor: input.commitInfo.authorName,
    sourceAuthorEmail: input.commitInfo.authorEmail,
    sourceAuthorDate: input.commitInfo.authorDate,
    sourceCommitter: input.commitInfo.committerName,
    sourceCommitterEmail: input.commitInfo.committerEmail,
    sourceCommitterDate: input.commitInfo.committerDate,
    sourceDirectory: input.sourceDirectory,
    timestamp: input.timestamp,
    instanceId: input.instanceId,
  };
  const subject = renderTemplate(input.commit.template, values).trim();
  const trailers = Object.entries(input.commit.trailers)
    .map(([key, template]) => {
      const value = renderTemplate(template, values).replace(/\n/g, '\n  ');
      return `${key}: ${value}`;
    })
    .join('\n');
  return `${subject}\n\n${trailers}`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
}
