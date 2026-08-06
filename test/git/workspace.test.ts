import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureRemote, ensureSourceWorkspace } from '../../src/git/workspace.js';
import { commitFiles, createBareRepo, createSourceRepo, fileUrl, tempDirectory } from '../helpers.js';

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
