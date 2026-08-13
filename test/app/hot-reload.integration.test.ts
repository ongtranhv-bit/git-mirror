import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLogger } from '../../src/shared/logger.js';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { runWorker } from '../../src/app/run.js';
import { configHash } from '../../src/config/live.js';
import type { AppConfig } from '../../src/types.js';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error('waitFor timed out');
}

test('runWorker applies RTDB config changes live and uses the new config for later events', async () => {
  const root = await tempDirectory('hot-reload-worker-');
  const source = await createSourceRepo(root, 'app', { 'app.txt': 'v1' });
  const bareDestA = await createBareRepo(root, 'mirror-a');
  const bareDestB = await createBareRepo(root, 'mirror-b');

  const configA = baseConfig(resolve(root, 'cache'), { mirror: destination('one-to-one') });
  const configB: AppConfig = {
    ...configA,
    dest: { ...configA.dest, mirror2: destination('one-to-one') },
  };
  const client = new MemoryRtdbClient();
  const instanceId = 'hot-worker';
  const adapterA = new FakeProvider('mirror', configA.dest.mirror!, fileUrl(bareDestA));
  const adapterB = new FakeProvider('mirror2', configB.dest.mirror2!, fileUrl(bareDestB));

  const runPromise = runWorker({
    config: configA,
    client,
    logger: createLogger('error'),
    instanceId,
    reloadConfig: true,
    adapters: { mirror: adapterA, mirror2: adapterB },
  });

  try {
    await waitFor(async () => (await client.get(`${configA.rtdb.instancesPath}/${instanceId}`)) !== null);
    await sleep(150);

    const firstSha = await commitFiles(source.path, { 'app.txt': 'v2' }, 'second commit');
    await client.set(`${configA.rtdb.pendingPath}/evt-a`, {
      ...hook(source.path, 'app', firstSha, 'evt-a'),
      targetDestinations: ['mirror'],
    });
    await waitFor(async () => (await client.get(`${configA.rtdb.processedPath}/evt-a`)) !== null);
    assert.equal(await git(bareDestA, ['rev-parse', 'refs/heads/main']), firstSha);

    await client.set(configA.rtdb.configPath, Buffer.from(JSON.stringify(configB), 'utf8').toString('base64'));
    await waitFor(async () => {
      const record = await client.get<{ configHash?: string }>(`${configA.rtdb.instancesPath}/${instanceId}`);
      return record?.configHash === configHash(configB);
    });

    const secondSha = await commitFiles(source.path, { 'app.txt': 'v3' }, 'third commit');
    await client.set(`${configA.rtdb.pendingPath}/evt-b`, {
      ...hook(source.path, 'app', secondSha, 'evt-b'),
      targetDestinations: ['mirror2'],
    });
    await waitFor(async () => (await client.get(`${configA.rtdb.processedPath}/evt-b`)) !== null);

    const resultB = await client.get<{ destinations: Array<{ destinationId: string; status: string }> }>(`${configA.rtdb.processedPath}/evt-b`);
    assert.equal(resultB?.destinations[0]?.destinationId, 'mirror2');
    assert.equal(resultB?.destinations[0]?.status, 'synced');
    assert.equal(await git(bareDestB, ['rev-parse', 'refs/heads/main']), secondSha);
    assert.equal(await git(bareDestA, ['rev-parse', 'refs/heads/main']), firstSha, 'old destination must be untouched');
  } finally {
    process.kill(process.pid, 'SIGTERM');
    await runPromise;
  }
});
