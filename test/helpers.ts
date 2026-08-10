import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { runCommand } from '../src/shared/exec.js';
import type { AppConfig, DestinationConfig, HookEvent, RemoteRepository, RepoLocator } from '../src/types.js';
import type { CreateRepoInput, ListBranchCommitsInput, ProviderAdapter } from '../src/providers/provider.js';

process.env.ALLOW_FILE_GIT_URLS = '1';

export async function tempDirectory(prefix = 'git-mirror-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await runCommand('git', args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

export async function createSourceRepo(root: string, name: string, files: Record<string, string>): Promise<{ path: string; sha: string }> {
  const path = resolve(root, name);
  await mkdir(path, { recursive: true });
  await git(path, ['init', '-b', 'main']);
  for (const [file, content] of Object.entries(files)) {
    const full = resolve(path, file);
    await mkdir(resolve(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-m', `initial ${name}`]);
  return { path, sha: await git(path, ['rev-parse', 'HEAD']) };
}

export async function commitFiles(path: string, files: Record<string, string | null>, message: string): Promise<string> {
  const { rm } = await import('node:fs/promises');
  for (const [file, content] of Object.entries(files)) {
    const full = resolve(path, file);
    if (content === null) await rm(full, { force: true, recursive: true });
    else {
      await mkdir(resolve(full, '..'), { recursive: true });
      await writeFile(full, content);
    }
  }
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-m', message]);
  return git(path, ['rev-parse', 'HEAD']);
}

export async function createBareRepo(root: string, name: string): Promise<string> {
  const path = resolve(root, `${name}.git`);
  await mkdir(path, { recursive: true });
  await git(path, ['init', '--bare']);
  await git(path, ['config', 'uploadpack.allowFilter', 'true']);
  return path;
}

export interface GitDaemon {
  url(name: string): string;
  stop(): Promise<void>;
}

export async function startGitDaemon(basePath: string): Promise<GitDaemon> {
  const port = 17_000 + Math.floor(Math.random() * 5_000);
  const child = spawn('git', [
    'daemon',
    '--export-all',
    '--enable=receive-pack',
    `--base-path=${basePath}`,
    '--reuseaddr',
    '--listen=127.0.0.1',
    `--port=${port}`,
  ], { stdio: 'ignore' });
  await new Promise<void>((resolveReady, reject) => {
    child.once('error', reject);
    const deadline = Date.now() + 15_000;
    const poll = () => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      const onOk = () => {
        socket.destroy();
        resolveReady();
      };
      socket.once('connect', onOk);
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('git daemon failed to start'));
        else setTimeout(poll, 100);
      });
    };
    poll();
  });
  return {
    url: (name: string) => `git://127.0.0.1:${port}/${name}`,
    stop: async () => {
      child.kill('SIGTERM');
    },
  };
}

export function fileUrl(path: string): string {
  return new URL(`file://${path}`).toString();
}

export function baseConfig(workdir: string, destinations: Record<string, DestinationConfig>): AppConfig {
  return {
    configVersion: 6,
    src: {
      creds: {
        github: { type: 'github', token: 'source-secret' },
      },
    },
    dest: destinations,
    runtime: {
      workdir,
      lockTtlSeconds: 60,
      heartbeatSeconds: 5,
      maxRetries: 1,
      retryBackoffMs: 10,
      maxEventRetries: 3,
      gitTimeoutMs: 30_000,
      apiTimeoutMs: 5_000,
      logLevel: 'error',
      codespaceKeepalive: { enabled: false, intervalMinutes: 10 },
    },
    rtdb: {
      configPath: '/sync/config',
      webhookPath: '/github-noti',
      pendingPath: '/sync/events/pending',
      processingPath: '/sync/events/processing',
      processedPath: '/sync/events/processed',
      failedPath: '/sync/events/failed',
      statePath: '/sync/state',
      locksPath: '/sync/locks',
      instancesPath: '/sync/instances',
      retentionDays: 14,
    },
  };
}

export function destination(mode: 'one-to-one' | 'many-to-one', repo = '{sourceRepo}'): DestinationConfig {
  const base = {
    enabled: true,
    type: 'github' as const,
    creds: { type: 'github' as const, token: 'destination-secret' },
    org: 'mirror',
    repo,
    autoCreate: { enabled: true, private: true },
    branch: 'main',
    push: {
      force: true,
      pushTags: true,
      deleteMissingRefs: false,
      include: ['refs/heads/*', 'refs/tags/*'],
      exclude: [],
    },
    commit: {
      authorName: 'mirror-bot',
      authorEmail: 'mirror@example.com',
      committerName: 'mirror-bot',
      committerEmail: 'mirror@example.com',
      messagePrefix: '[sync]',
      template: '{{prefix}} {{sourceRepo}}: {{sourceSubject}}',
      trailers: {
        'Source-Repo': '{{sourceOwner}}/{{sourceRepo}}',
        'Source-Commit': '{{sourceSha}}',
        'Source-Directory': '{{sourceDirectory}}',
      },
    },
  };
  if (mode === 'one-to-one') return { ...base, mode };
  return { ...base, mode, directory: '{sourceRepo}', directoryMap: {} };
}

export function hook(path: string, repo: string, sha: string, eventId = `event-${sha.slice(0, 8)}`): HookEvent {
  return {
    eventId,
    provider: 'github',
    repo: `source/${repo}`,
    url: fileUrl(path),
    ref: 'refs/heads/main',
    after: sha,
    receivedAt: Date.now(),
  };
}

export class FakeProvider implements ProviderAdapter {
  readonly destinationId: string;
  readonly config: DestinationConfig;
  readonly repository: RemoteRepository;

  constructor(destinationId: string, config: DestinationConfig, cloneUrl: string) {
    this.destinationId = destinationId;
    this.config = config;
    this.repository = {
      provider: config.type,
      org: config.org,
      repo: config.repo,
      cloneUrl,
    };
  }

  async validateCredential(): Promise<void> {}
  async getRepository(input: RepoLocator): Promise<RemoteRepository | null> {
    return { ...this.repository, org: input.org, repo: input.repo, project: input.project };
  }
  async createRepository(input: CreateRepoInput): Promise<RemoteRepository> {
    return { ...this.repository, ...input, created: true };
  }
  async listBranchCommitMessages(_input: ListBranchCommitsInput): Promise<string[]> {
    return [];
  }
  resolveCloneUrl(_input: RepoLocator): string {
    return this.repository.cloneUrl;
  }
}
