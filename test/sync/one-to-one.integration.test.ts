import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLogger } from '../../src/shared/logger.js';
import { processHookEvent } from '../../src/sync/router.js';
import {
  FakeProvider,
  baseConfig,
  createBareRepo,
  createSourceRepo,
  destination,
  fileUrl,
  git,
  hook,
  tempDirectory,
} from '../helpers.js';

test('one-to-one sync pushes branches, tags and history to a local bare destination', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'hello' });
  await git(source.path, ['tag', 'v1.0.0']);
  const bareDestination = await createBareRepo(root, 'mirror-app');
  const config = baseConfig(resolve(root, 'cache'), { mirror: destination('one-to-one') });
  const adapter = new FakeProvider('mirror', config.dest.mirror!, fileUrl(bareDestination));

  const result = await processHookEvent({
    config,
    hook: hook(source.path, 'app', source.sha),
    instanceId: 'worker-one',
    logger: createLogger('error'),
    adapters: { mirror: adapter },
  });

  assert.equal(result.destinations[0]?.status, 'synced');
  assert.equal(await git(bareDestination, ['rev-parse', 'refs/heads/main']), source.sha);
  assert.equal(await git(bareDestination, ['rev-parse', 'refs/tags/v1.0.0']), source.sha);
  const count = Number(await git(bareDestination, ['rev-list', '--count', 'refs/heads/main']));
  assert.equal(count, 1);
});


test('one-to-one deleteMissingRefs removes stale destination refs covered by push policy', async () => {
  const root = await tempDirectory();
  const source = await createSourceRepo(root, 'prune-app', { 'app.txt': 'hello' });
  const bareDestination = await createBareRepo(root, 'prune-mirror');
  await git(source.path, ['remote', 'add', 'seed', fileUrl(bareDestination)]);
  await git(source.path, ['branch', 'stale']);
  await git(source.path, ['push', 'seed', 'refs/heads/main:refs/heads/main', 'refs/heads/stale:refs/heads/stale']);
  await git(source.path, ['branch', '-D', 'stale']);

  const dest = destination('one-to-one');
  dest.push.deleteMissingRefs = true;
  const config = baseConfig(resolve(root, 'cache-prune'), { mirror: dest });
  const adapter = new FakeProvider('mirror', dest, fileUrl(bareDestination));
  await processHookEvent({
    config,
    hook: hook(source.path, 'prune-app', source.sha, 'prune-event'),
    instanceId: 'worker-prune',
    logger: createLogger('error'),
    adapters: { mirror: adapter },
  });

  const stale = await git(bareDestination, ['show-ref', '--verify', '--quiet', 'refs/heads/stale']).then(() => true, () => false);
  assert.equal(stale, false);
});
