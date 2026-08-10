import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureDestinationWorkspace, ensureRemote, ensureSourceWorkspace } from '../../src/git/workspace.js';
import {
  commitFiles,
  createBareRepo,
  createSourceRepo,
  fileUrl,
  git,
  startGitDaemon,
  tempDirectory,
} from '../helpers.js';

test('clones once, fetches on later runs, and does not persist credentials', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'source', { 'a.txt': 'one' });
  const runtimeSource = {
    provider: 'github' as const,
    owner: 'source',
    repo: 'source',
    fullName: 'source/source',
    url: fileUrl(source.path),
    ref: 'refs/heads/main',
    sha: source.sha,
    credential: { type: 'github' as const, token: 'do-not-persist' },
  };
  const workspace = await ensureSourceWorkspace(runtimeSource, resolve(root, 'cache'), 30_000);
  const secondSha = await commitFiles(source.path, { 'b.txt': 'two' }, 'second');
  runtimeSource.sha = secondSha;
  const sameWorkspace = await ensureSourceWorkspace(runtimeSource, resolve(root, 'cache'), 30_000);
  assert.equal(sameWorkspace, workspace);
  const config = await readFile(resolve(workspace, 'config'), 'utf8');
  assert.doesNotMatch(config, /do-not-persist/);

  const destinationA = await createBareRepo(root, 'destination-a');
  const destinationB = await createBareRepo(root, 'destination-b');
  assert.equal(await ensureRemote(workspace, 'dst', fileUrl(destinationA), 30_000), 'added');
  assert.equal(await ensureRemote(workspace, 'dst', fileUrl(destinationA), 30_000), 'unchanged');
  assert.equal(await ensureRemote(workspace, 'dst', fileUrl(destinationB), 30_000), 'updated');
});

test('sparse destination workspace uses a blobless+sparse clone and skips out-of-cone blobs', async () => {
  const root = await tempDirectory();
  const monorepo = await createSourceRepo(root, 'monorepo', { 'a/file.txt': 'a-v1', 'b/file.txt': 'b-v1' });
  const bare = await createBareRepo(root, 'monorepo');
  await git(monorepo.path, ['push', fileUrl(bare), 'main']);
  const daemon = await startGitDaemon(root);

  const workspace = await ensureDestinationWorkspace(
    daemon.url('monorepo.git'),
    'main',
    { type: 'github', token: 'secret' },
    resolve(root, 'cache'),
    30_000,
    ['a'],
  );
  await daemon.stop();

  assert.equal(await git(workspace, ['config', '--get', 'remote.origin.promisor']), 'true');
  assert.equal(await git(workspace, ['config', '--get', 'remote.origin.partialclonefilter']), 'blob:none');

  const entries = await readdir(workspace);
  assert.ok(entries.includes('a'), 'in-cone directory should be checked out');
  assert.ok(!entries.includes('b'), 'out-of-cone directory should not be checked out');

  const inCone = await git(workspace, ['ls-tree', 'origin/main', 'a/file.txt']);
  const outOfCone = await git(workspace, ['ls-tree', 'origin/main', 'b/file.txt']);
  const inConeOid = inCone.split(/\s+/)[2];
  const outOfConeOid = outOfCone.split(/\s+/)[2];
  const noLazyFetch = { GIT_NO_LAZY_FETCH: '1' };
  assert.equal(await git(workspace, ['cat-file', '-e', inConeOid!], noLazyFetch).then(() => 'exists'), 'exists');
  await assert.rejects(() => git(workspace, ['cat-file', '-e', outOfConeOid!], noLazyFetch));
});

test('non-sparse destination workspace uses a blobless full-tree clone', async () => {
  const root = await tempDirectory();
  const monorepo = await createSourceRepo(root, 'monorepo', { 'a/file.txt': 'a-v1', 'b/file.txt': 'b-v1' });
  const bare = await createBareRepo(root, 'monorepo');
  await git(monorepo.path, ['push', fileUrl(bare), 'main']);

  const workspace = await ensureDestinationWorkspace(
    fileUrl(bare),
    'main',
    { type: 'github', token: 'secret' },
    resolve(root, 'cache'),
    30_000,
  );

  assert.equal(await git(workspace, ['config', '--get', 'remote.origin.promisor']), 'true');
  assert.equal(await git(workspace, ['config', '--get', 'remote.origin.partialclonefilter']), 'blob:none');
  const entries = await readdir(workspace);
  assert.ok(entries.includes('a'));
  assert.ok(entries.includes('b'));
});
