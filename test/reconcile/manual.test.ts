import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { reconcileRepositories } from '../../src/reconcile/manual.js';
import { discoverGithubRepositories } from '../../src/reconcile/github-source.js';
import type { DiscoveredSourceRepository } from '../../src/reconcile/github-source.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
import type { DestinationConfig } from '../../src/types.js';
import type { ListBranchCommitsInput } from '../../src/providers/provider.js';
import {
  FakeProvider,
  baseConfig,
  createBareRepo,
  createSourceRepo,
  destination,
  fileUrl,
  git,
  tempDirectory,
} from '../helpers.js';

class CommitMessageProvider extends FakeProvider {
  private readonly messages: string[];

  constructor(destinationId: string, config: DestinationConfig, cloneUrl: string, messages: string[]) {
    super(destinationId, config, cloneUrl);
    this.messages = messages;
  }

  override async listBranchCommitMessages(_input: ListBranchCommitsInput): Promise<string[]> {
    return this.messages;
  }}

function sourceRepo(source: { path: string; sha: string }): DiscoveredSourceRepository {
  return {
    provider: 'github',
    credentialId: 'github',
    credential: { type: 'github', token: 'source-secret' },
    owner: 'source',
    repo: 'app',
    fullName: 'source/app',
    url: fileUrl(source.path),
    defaultBranch: 'main',
  };
}

test('manual reconcile queues only drifted destinations and leaves in-sync destinations alone', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });
  const syncedBare = await createBareRepo(root, 'synced');
  const driftBare = await createBareRepo(root, 'drift');
  await git(source.path, ['remote', 'add', 'synced', fileUrl(syncedBare)]);
  await git(source.path, ['push', 'synced', 'refs/heads/main:refs/heads/main']);

  const syncedConfig = destination('one-to-one');
  const driftConfig = destination('one-to-one');
  const config = baseConfig(resolve(root, 'cache'), { synced: syncedConfig, drift: driftConfig });
  const client = new MemoryRtdbClient();
  const result = await reconcileRepositories({
    config,
    client,
    logger: createLogger('error'),
    repoDelayMs: 0,
    apiDelayMs: 0,
    adapters: {
      synced: new FakeProvider('synced', syncedConfig, fileUrl(syncedBare)),
      drift: new FakeProvider('drift', driftConfig, fileUrl(driftBare)),
    },
    discoveredRepositories: [sourceRepo(source)],
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.sourceTotal, 1);
  assert.equal(result.sourceSelected, 1);
  assert.equal(result.destinationChecksTotal, 2);
  assert.equal(result.destinationExisting, 2);
  assert.equal(result.destinationMissing, 0);
  assert.equal(result.needsReconcile, 1);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.queued, 1);
  const repository = result.repositories[0]!;
  assert.deepEqual(repository.targetDestinations, ['drift']);
  const pending = await client.get<Record<string, { targetDestinations?: string[]; sourceCredentialId?: string }>>(config.rtdb.pendingPath);
  assert.ok(pending);
  const event = Object.values(pending)[0]!;
  assert.deepEqual(event.targetDestinations, ['drift']);
  assert.equal(event.sourceCredentialId, 'github');
});

test('manual reconcile reports destination missing without using RTDB repository state', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });
  const config = destination('one-to-one');
  const full = baseConfig(resolve(root, 'cache'), { missing: config });
  const client = new MemoryRtdbClient();
  await client.set(`${full.rtdb.statePath}/repositories/missing`, { repo: 'stale-rtdb-state' });
  class MissingProvider extends FakeProvider {
    override async getRepository(): Promise<null> { return null; }
  }

  const result = await reconcileRepositories({
    config: full,
    client,
    logger: createLogger('error'),
    dryRun: true,
    repoDelayMs: 0,
    apiDelayMs: 0,
    adapters: { missing: new MissingProvider('missing', config, fileUrl(resolve(root, 'missing.git'))) },
    discoveredRepositories: [sourceRepo(source)],
  });

  assert.equal(result.destinationChecksTotal, 1);
  assert.equal(result.destinationExisting, 0);
  assert.equal(result.destinationMissing, 1);
  assert.equal(result.needsReconcile, 1);
  assert.equal(result.valid, 0);
  assert.equal(result.invalid, 1);
  assert.equal(result.wouldQueue, 1);
  assert.equal(await client.get(full.rtdb.pendingPath), null);
  assert.equal(result.repositories[0]?.destinations?.[0]?.reason, 'destination-missing');
});

test('GitHub source discovery scans comma-separated reconcile orgs with pagination and dedupe', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}?page=${url.searchParams.get('page')}`);
    const page = url.searchParams.get('page');
    const org = url.pathname.split('/')[2];
    const repos = page === '1'
      ? [{ id: 1, name: 'app', full_name: `${org}/app`, clone_url: `https://github.com/${org}/app.git`, default_branch: 'main', owner: { login: org } }]
      : [];
    return new Response(JSON.stringify(repos), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const repositories = await discoverGithubRepositories({
      credentialId: 'github',
      credential: { type: 'github', token: 'secret' },
      apiTimeoutMs: 5_000,
      apiDelayMs: 0,
      orgs: ['org-a', 'org-a', 'org-b'],
    });
    assert.deepEqual(repositories.map((item) => item.fullName), ['org-a/app', 'org-b/app']);
    assert.equal(seen.filter((item) => item === '/orgs/org-a/repos?page=1').length, 1);
    assert.ok(seen.includes('/orgs/org-b/repos?page=1'));
  } finally {
    globalThis.fetch = original;
  }
});

test('manual reconcile marks many-to-one in-sync when the source commit marker is in destination history', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });
  const destBare = await createBareRepo(root, 'mono');
  await seedManyToOneDirectory(root, destBare, 'app');

  const config = destination('many-to-one');
  const full = baseConfig(resolve(root, 'cache'), { mono: config });
  const client = new MemoryRtdbClient();
  const result = await reconcileRepositories({
    config: full,
    client,
    logger: createLogger('error'),
    repoDelayMs: 0,
    apiDelayMs: 0,
    adapters: {
      mono: new CommitMessageProvider('mono', config, fileUrl(destBare), [
        `[sync] app: init\n\nSource-Commit: ${source.sha}\nSource-Directory: app`,
      ]),
    },
    discoveredRepositories: [sourceRepo(source)],
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.inSync, 1);
  assert.equal(result.queued, 0);
  assert.deepEqual(result.repositories[0]?.destinations, [{ destinationId: 'mono', status: 'in-sync' }]);
});

test('manual reconcile marks many-to-one drifted when the source commit marker is missing', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });
  const destBare = await createBareRepo(root, 'mono');
  await seedManyToOneDirectory(root, destBare, 'app');

  const config = destination('many-to-one');
  const full = baseConfig(resolve(root, 'cache'), { mono: config });
  const client = new MemoryRtdbClient();
  const result = await reconcileRepositories({
    config: full,
    client,
    logger: createLogger('error'),
    repoDelayMs: 0,
    apiDelayMs: 0,
    adapters: {
      mono: new CommitMessageProvider('mono', config, fileUrl(destBare), ['[sync] app: something-else']),
    },
    discoveredRepositories: [sourceRepo(source)],
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.queued, 1);
  const repository = result.repositories[0]!;
  assert.equal(repository.status, 'queued');
  assert.deepEqual(repository.targetDestinations, ['mono']);
  assert.deepEqual(repository.destinations, [
    { destinationId: 'mono', status: 'drift', reason: 'source-commit-not-synced' },
  ]);
});

async function seedManyToOneDirectory(root: string, bare: string, directory: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const work = resolve(root, `seed-${directory}-${Math.random().toString(16).slice(2)}`);
  await mkdir(work, { recursive: true });
  await git(work, ['init', '-b', 'main']);
  await git(work, ['remote', 'add', 'origin', fileUrl(bare)]);
  await mkdir(resolve(work, directory), { recursive: true });
  await writeFile(resolve(work, directory, 'app.txt'), 'v1');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', 'seed monorepo directory']);
  await git(work, ['push', 'origin', 'refs/heads/main:refs/heads/main']);
}

test('manual reconcile falls back to tree comparison when no sourceSha trailer is configured', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });

  const destBare = await createBareRepo(root, 'mono');
  const destWork = resolve(root, 'mono-work');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(destWork, { recursive: true });
  await git(destWork, ['init', '-b', 'main']);
  await git(destWork, ['remote', 'add', 'origin', fileUrl(destBare)]);

  const appDir = resolve(destWork, 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(resolve(appDir, 'app.txt'), 'v1');
  await git(destWork, ['add', '-A']);
  await git(destWork, ['commit', '-m', 'seed dest']);
  await git(destWork, ['push', 'origin', 'refs/heads/main:refs/heads/main']);

  const config = { ...destination('many-to-one'), commit: { ...destination('many-to-one').commit, trailers: { 'Source-Repo': '{{sourceOwner}}/{{sourceRepo}}' } } };
  const full = baseConfig(resolve(root, 'cache'), { mono: config });
  const client = new MemoryRtdbClient();
  const result = await reconcileRepositories({
    config: full,
    client,
    logger: createLogger('error'),
    repoDelayMs: 0,
    apiDelayMs: 0,
    adapters: {
      mono: new FakeProvider('mono', config, fileUrl(destBare)),
    },
    discoveredRepositories: [sourceRepo(source)],
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.inSync, 1);
  assert.deepEqual(result.repositories[0]?.destinations, [{ destinationId: 'mono', status: 'in-sync' }]);
});
