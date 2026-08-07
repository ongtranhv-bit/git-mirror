import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { shouldPublishRuntimeStatus, startRuntimeStatus } from '../../src/codespace/runtime-status.js';
import type { RuntimeReadinessRecord } from '../../src/codespace/types.js';

test('runtime status stays starting until markReady then records listener readiness', async () => {
  const client = new MemoryRtdbClient();
  const controller = startRuntimeStatus({
    client,
    path: '/sync/codespace/instances',
    instanceId: 'runtime-1',
    intervalSeconds: 60,
    currentEvent: () => undefined,
    metadata: { codespaceName: 'cs1', runtimeCommitSha: 'sha1', repository: 'org/runner', serviceVersion: '0.2.0' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const starting = await client.get<RuntimeReadinessRecord>('/sync/codespace/instances/runtime-1');
  assert.equal(starting?.status, 'starting');
  assert.equal(starting?.listenerAttached, false);
  await controller.markReady();
  const ready = await client.get<RuntimeReadinessRecord>('/sync/codespace/instances/runtime-1');
  assert.equal(ready?.status, 'ready');
  assert.equal(ready?.listenerAttached, true);
  assert.equal(ready?.runtimeCommitSha, 'sha1');
  await controller.stop();
  assert.equal((await client.get<RuntimeReadinessRecord>('/sync/codespace/instances/runtime-1'))?.status, 'stopped');
});

test('runtime status derives instances path from custom rotation base path and reports service version env', async () => {
  const oldBase = process.env.CODESPACE_ROTATION_BASE_PATH;
  const oldReadiness = process.env.CODESPACE_READINESS_PATH;
  const oldVersion = process.env.RUNTIME_SERVICE_VERSION;
  process.env.CODESPACE_ROTATION_BASE_PATH = '/custom/control';
  delete process.env.CODESPACE_READINESS_PATH;
  process.env.RUNTIME_SERVICE_VERSION = '0.2.0-test';
  try {
    const client = new MemoryRtdbClient();
    const controller = startRuntimeStatus({
      client,
      instanceId: 'runtime-custom',
      intervalSeconds: 60,
      currentEvent: () => undefined,
      metadata: { codespaceName: 'cs-custom', runtimeCommitSha: 'sha-custom' },
    });
    await controller.markReady();
    const ready = await client.get<RuntimeReadinessRecord>('/custom/control/instances/runtime-custom');
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.serviceVersion, '0.2.0-test');
    await controller.stop();
  } finally {
    if (oldBase === undefined) delete process.env.CODESPACE_ROTATION_BASE_PATH; else process.env.CODESPACE_ROTATION_BASE_PATH = oldBase;
    if (oldReadiness === undefined) delete process.env.CODESPACE_READINESS_PATH; else process.env.CODESPACE_READINESS_PATH = oldReadiness;
    if (oldVersion === undefined) delete process.env.RUNTIME_SERVICE_VERSION; else process.env.RUNTIME_SERVICE_VERSION = oldVersion;
  }
});


test('runtime readiness publishing is opt-in to an actual GitHub Codespace environment', () => {
  assert.equal(shouldPublishRuntimeStatus({}), false);
  assert.equal(shouldPublishRuntimeStatus({ CODESPACES: 'true' }), false);
  assert.equal(shouldPublishRuntimeStatus({ CODESPACE_NAME: 'cs1' }), false);
  assert.equal(shouldPublishRuntimeStatus({ CODESPACES: 'true', CODESPACE_NAME: 'cs1' }), true);
});
