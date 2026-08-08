import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { reconcileRepositories } from '../../src/reconcile/manual.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';
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
    discoveredRepositories: [{
      provider: 'github',
      credentialId: 'github',
      credential: config.src.creds.github!,
      owner: 'source',
      repo: 'app',
      fullName: 'source/app',
      url: fileUrl(source.path),
      defaultBranch: 'main',
    }],
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.queued, 1);
  const repository = result.repositories[0]!;
  assert.deepEqual(repository.targetDestinations, ['drift']);
  const pending = await client.get<Record<string, { targetDestinations?: string[]; sourceCredentialId?: string }>>(config.rtdb.pendingPath);
  assert.ok(pending);
  const event = Object.values(pending)[0]!;
  assert.deepEqual(event.targetDestinations, ['drift']);
  assert.equal(event.sourceCredentialId, 'github');
});
