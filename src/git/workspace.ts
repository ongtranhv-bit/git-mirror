import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CredentialConfig, SourceRepository } from '../types.js';
import { AppError } from '../shared/errors.js';
import { runCommand, type CommandResult } from '../shared/exec.js';
import { stableHash } from '../shared/paths.js';
import { gitCredentialEnv } from './auth.js';

export interface GitRunOptions {
  cwd: string;
  credential?: CredentialConfig;
  timeoutMs: number;
  allowFailure?: boolean;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runGit(args: string[], options: GitRunOptions): Promise<CommandResult> {
  // Force HTTP/1.1 for git smart HTTP: HTTP/2 stream cancellations cause
  // "RPC failed; curl 92 ... CANCEL" during pushes to Azure DevOps.
  return runCommand('git', ['-c', 'http.version=HTTP/1.1', ...args], {
    cwd: options.cwd,
    env: options.credential ? gitCredentialEnv(options.credential, options.env ?? process.env) : options.env ?? process.env,
    timeoutMs: options.timeoutMs,
    allowFailure: options.allowFailure,
    input: options.input,
    errorCode: 'GIT_COMMAND_FAILED',
  });
}

export async function ensureSourceWorkspace(
  source: SourceRepository,
  workdir: string,
  timeoutMs: number,
): Promise<string> {
  validateSourceUrl(source.url);
  const workspace = resolve(workdir, 'source', source.provider, `${stableHash(`${source.provider}:${source.url}`)}.git`);
  await mkdir(dirname(workspace), { recursive: true });
  if (await pathExists(workspace)) {
    const check = await runGit(['rev-parse', '--is-bare-repository'], {
      cwd: workspace,
      timeoutMs,
      allowFailure: true,
    });
    if (check.exitCode !== 0 || check.stdout.trim() !== 'true') {
      await rm(workspace, { recursive: true, force: true });
    }
  }
  if (!(await pathExists(workspace))) {
    await runGit(['clone', '--mirror', '--filter=blob:none', source.url, workspace], {
      cwd: dirname(workspace),
      credential: source.credential,
      timeoutMs,
    });
  } else {
    await runGit(['remote', 'set-url', 'origin', source.url], { cwd: workspace, timeoutMs });
    await runGit(['fetch', '--prune', '--tags', 'origin'], {
      cwd: workspace,
      credential: source.credential,
      timeoutMs,
    });
  }
  await ensureCommitAvailable(workspace, source, timeoutMs);
  return workspace;
}

export async function fetchSource(workspace: string, source: SourceRepository, timeoutMs: number): Promise<void> {
  await runGit(['fetch', '--prune', '--tags', 'origin', source.ref], {
    cwd: workspace,
    credential: source.credential,
    timeoutMs,
  });
}

export async function ensureCommitAvailable(
  workspace: string,
  source: SourceRepository,
  timeoutMs: number,
): Promise<void> {
  let check = await runGit(['cat-file', '-e', `${source.sha}^{commit}`], {
    cwd: workspace,
    timeoutMs,
    allowFailure: true,
  });
  if (check.exitCode === 0) return;
  await fetchSource(workspace, source, timeoutMs);
  check = await runGit(['cat-file', '-e', `${source.sha}^{commit}`], {
    cwd: workspace,
    timeoutMs,
    allowFailure: true,
  });
  if (check.exitCode !== 0) {
    throw new AppError('GIT_SOURCE_COMMIT_MISSING', `Source commit ${source.sha} is not available after fetch.`, {
      context: { sourceRepo: source.fullName, sourceRef: source.ref, sourceSha: source.sha },
    });
  }
}

export async function ensureRemote(
  workspace: string,
  name: string,
  url: string,
  timeoutMs: number,
): Promise<'added' | 'updated' | 'unchanged'> {
  validateSourceUrl(url);
  const result = await runGit(['remote', 'get-url', name], { cwd: workspace, timeoutMs, allowFailure: true });
  if (result.exitCode !== 0) {
    await runGit(['remote', 'add', name, url], { cwd: workspace, timeoutMs });
    return 'added';
  }
  if (result.stdout.trim() !== url) {
    await runGit(['remote', 'set-url', name, url], { cwd: workspace, timeoutMs });
    return 'updated';
  }
  return 'unchanged';
}

export async function ensureDestinationWorkspace(
  cloneUrl: string,
  branch: string,
  credential: CredentialConfig,
  workdir: string,
  timeoutMs: number,
  sparseDirectories: string[] = [],
): Promise<string> {
  validateSourceUrl(cloneUrl);
  const workspace = resolve(workdir, 'destination', stableHash(cloneUrl));
  await mkdir(dirname(workspace), { recursive: true });
  if (!(await pathExists(join(workspace, '.git')))) {
    await rm(workspace, { recursive: true, force: true });
    const args = sparseDirectories.length > 0
      ? ['clone', '--filter=blob:none', '--no-checkout', '--sparse', cloneUrl, workspace]
      : ['clone', '--filter=blob:none', cloneUrl, workspace];
    await runGit(args, {
      cwd: dirname(workspace),
      credential,
      timeoutMs,
    });
  } else {
    await ensureRemote(workspace, 'origin', cloneUrl, timeoutMs);
  }
  if (sparseDirectories.length > 0) {
    await runGit(['sparse-checkout', 'init', '--cone'], { cwd: workspace, timeoutMs, credential, allowFailure: true });
    await runGit(['sparse-checkout', 'set', ...sparseDirectories], { cwd: workspace, timeoutMs, credential });
  }
  await runGit(['fetch', '--prune', '--tags', 'origin'], {
    cwd: workspace,
    credential,
    timeoutMs,
  });
  await checkoutDestinationBranch(workspace, branch, timeoutMs, credential);
  return workspace;
}

export async function checkoutDestinationBranch(
  workspace: string,
  branch: string,
  timeoutMs: number,
  credential?: CredentialConfig,
): Promise<void> {
  const runCredential = credential ? { credential } : {};
  const remote = await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    cwd: workspace,
    timeoutMs,
    ...runCredential,
    allowFailure: true,
  });
  if (remote.exitCode === 0) {
    await runGit(['checkout', '-B', branch, `origin/${branch}`], { cwd: workspace, timeoutMs, ...runCredential });
    await runGit(['reset', '--hard', `origin/${branch}`], { cwd: workspace, timeoutMs, ...runCredential });
  } else {
    const local = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: workspace,
      timeoutMs,
      ...runCredential,
      allowFailure: true,
    });
    if (local.exitCode === 0) await runGit(['checkout', branch], { cwd: workspace, timeoutMs, ...runCredential });
    else {
      await runGit(['checkout', '--orphan', branch], { cwd: workspace, timeoutMs, ...runCredential });
      await runGit(['rm', '-rf', '--ignore-unmatch', '.'], {
        cwd: workspace,
        timeoutMs,
        ...runCredential,
        allowFailure: true,
      });
      await runGit(['read-tree', '--empty'], { cwd: workspace, timeoutMs });
    }
  }
  await runGit(['clean', '-fdx'], { cwd: workspace, timeoutMs });
}

export async function createDetachedWorktree(
  bareWorkspace: string,
  sha: string,
  root: string,
  timeoutMs: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = resolve(root, 'worktrees', `${stableHash(`${bareWorkspace}:${sha}:${Date.now()}:${Math.random()}`)}`);
  await mkdir(dirname(path), { recursive: true });
  await runGit(['worktree', 'add', '--detach', path, sha], { cwd: bareWorkspace, timeoutMs });
  return {
    path,
    cleanup: async () => {
      await runGit(['worktree', 'remove', '--force', path], {
        cwd: bareWorkspace,
        timeoutMs,
        allowFailure: true,
      });
      await rm(path, { recursive: true, force: true });
      await runGit(['worktree', 'prune'], { cwd: bareWorkspace, timeoutMs, allowFailure: true });
    },
  };
}

export async function getCommitSubject(workspace: string, sha: string, timeoutMs: number): Promise<string> {
  const info = await getCommitInfo(workspace, sha, timeoutMs);
  return info.subject;
}

export interface CommitInfo {
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  sha: string;
  shortSha: string;
}

export async function getCommitInfo(
  workspace: string,
  sha: string,
  timeoutMs: number,
): Promise<CommitInfo> {
  const format = JSON.stringify({
    subject: '%s',
    body: '%b',
    authorName: '%an',
    authorEmail: '%ae',
    authorDate: '%ai',
    committerName: '%cn',
    committerEmail: '%ce',
    committerDate: '%ci',
  });
  const result = await runGit(['show', '-s', `--format=${format}`, sha], { cwd: workspace, timeoutMs });
  try {
    const info = JSON.parse(result.stdout.trim());
    return {
      subject: info.subject || sha.slice(0, 12),
      body: (info.body || '').trim(),
      authorName: info.authorName || 'unknown',
      authorEmail: info.authorEmail || 'unknown@unknown',
      authorDate: info.authorDate || new Date().toISOString(),
      committerName: info.committerName || 'unknown',
      committerEmail: info.committerEmail || 'unknown@unknown',
      committerDate: info.committerDate || new Date().toISOString(),
      sha,
      shortSha: sha.slice(0, 12),
    };
  } catch {
    return {
      subject: sha.slice(0, 12),
      body: '',
      authorName: 'unknown',
      authorEmail: 'unknown@unknown',
      authorDate: new Date().toISOString(),
      committerName: 'unknown',
      committerEmail: 'unknown@unknown',
      committerDate: new Date().toISOString(),
      sha,
      shortSha: sha.slice(0, 12),
    };
  }
}

export async function getHeadSha(workspace: string, timeoutMs: number): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: workspace, timeoutMs });
  return result.stdout.trim();
}

export function validateSourceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError('SOURCE_URL_INVALID', `Invalid repository URL: ${value}`, { cause: error });
  }
  if (
    url.protocol !== 'https:'
    && !(url.protocol === 'file:' && process.env.ALLOW_FILE_GIT_URLS === '1')
    && !(url.protocol === 'git:' && process.env.ALLOW_FILE_GIT_URLS === '1')
  ) {
    throw new AppError('SOURCE_URL_INVALID', `Repository URL must use HTTPS. file: and git: are allowed only when ALLOW_FILE_GIT_URLS=1 for local tests.`);
  }
  if (url.username || url.password) throw new AppError('SOURCE_URL_HAS_CREDENTIAL', 'Repository URL must not contain credentials.');
  for (const key of url.searchParams.keys()) {
    if (/auth|token|secret|password|pat/i.test(key)) {
      throw new AppError('SOURCE_URL_HAS_CREDENTIAL', `Repository URL contains a secret-like query parameter: ${key}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
