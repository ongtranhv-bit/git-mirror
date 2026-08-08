import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger } from '../../src/shared/logger.js';
import { processHookEvent } from '../../src/sync/router.js';
import {
  FakeProvider,
  baseConfig,
  commitFiles,
  createBareRepo,
  createSourceRepo,
  destination,
  fileUrl,
  git,
  hook,
  tempDirectory,
} from '../helpers.js';

async function cloneForRead(root: string, bare: string, name: string): Promise<string> {
  const path = resolve(root, name);
  await git(root, ['clone', '--branch', 'main', fileUrl(bare), path]);
  return path;
}

test('many-to-one synchronizes isolated directories, deletes stale files, and skips the same source SHA', async () => {
  const root = await tempDirectory();
  const app = await createSourceRepo(root, 'app', { 'app.txt': 'app-v1', 'remove.txt': 'delete-me' });
  const lib = await createSourceRepo(root, 'lib', { 'lib.txt': 'lib-v1' });
  const bareDestination = await createBareRepo(root, 'monorepo');
  const dest = destination('many-to-one', 'monorepo');
  const config = baseConfig(resolve(root, 'cache'), { monorepo: dest });
  const adapter = new FakeProvider('monorepo', dest, fileUrl(bareDestination));
  const common = {
    config,
    instanceId: 'worker-many',
    logger: createLogger('error'),
    adapters: { monorepo: adapter },
  };

  await processHookEvent({ ...common, hook: hook(app.path, 'app', app.sha, 'app-1') });
  await processHookEvent({ ...common, hook: hook(lib.path, 'lib', lib.sha, 'lib-1') });

  let readClone = await cloneForRead(root, bareDestination, 'read-1');
  assert.equal(await readFile(resolve(readClone, 'app/app.txt'), 'utf8'), 'app-v1');
  assert.equal(await readFile(resolve(readClone, 'lib/lib.txt'), 'utf8'), 'lib-v1');

  const appSha2 = await commitFiles(app.path, { 'app.txt': 'app-v2', 'remove.txt': null }, 'update app');
  await processHookEvent({ ...common, hook: hook(app.path, 'app', appSha2, 'app-2') });
  readClone = await cloneForRead(root, bareDestination, 'read-2');
  assert.equal(await readFile(resolve(readClone, 'app/app.txt'), 'utf8'), 'app-v2');
  await assert.rejects(access(resolve(readClone, 'app/remove.txt')));
  assert.equal(await readFile(resolve(readClone, 'lib/lib.txt'), 'utf8'), 'lib-v1');

  const before = Number(await git(bareDestination, ['rev-list', '--count', 'refs/heads/main']));
  const duplicate = await processHookEvent({ ...common, hook: hook(app.path, 'app', appSha2, 'app-duplicate') });
  const after = Number(await git(bareDestination, ['rev-list', '--count', 'refs/heads/main']));
  assert.equal(duplicate.destinations[0]?.status, 'skipped');
  assert.equal(after, before);

  const message = await git(bareDestination, ['log', '-1', '--format=%B', 'refs/heads/main']);
  assert.match(message, new RegExp(`Source-Commit: ${appSha2}`));
  assert.match(message, /Source-Directory: app/);
});


test('many-to-one repairs destination directory drift even when the same source SHA marker already exists', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app-repair', { 'app.txt': 'source-value' });
  const bareDestination = await createBareRepo(root, 'repair-monorepo');
  const dest = destination('many-to-one', 'monorepo');
  const config = baseConfig(resolve(root, 'cache-repair'), { monorepo: dest });
  const adapter = new FakeProvider('monorepo', dest, fileUrl(bareDestination));
  const common = {
    config,
    instanceId: 'worker-repair',
    logger: createLogger('error'),
    adapters: { monorepo: adapter },
  };

  await processHookEvent({ ...common, hook: hook(source.path, 'app-repair', source.sha, 'repair-1') });
  const manual = await cloneForRead(root, bareDestination, 'manual-edit');
  await writeFile(resolve(manual, 'app-repair/app.txt'), 'manual-drift');
  await git(manual, ['add', '-A']);
  await git(manual, ['commit', '-m', 'manual destination edit']);
  await git(manual, ['push', 'origin', 'main']);

  const repaired = await processHookEvent({ ...common, hook: hook(source.path, 'app-repair', source.sha, 'repair-2') });
  assert.equal(repaired.destinations[0]?.status, 'synced');
  const readClone = await cloneForRead(root, bareDestination, 'read-repaired');
  assert.equal(await readFile(resolve(readClone, 'app-repair/app.txt'), 'utf8'), 'source-value');
});
