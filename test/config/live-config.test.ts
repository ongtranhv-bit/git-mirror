import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { LiveConfig } from '../../src/config/live.js';
import { baseConfig, destination, tempDirectory } from '../helpers.js';

test('LiveConfig returns the initial snapshot until swap', async () => {
  const root = await tempDirectory('live-config-');
  const configA = baseConfig(resolve(root, 'cache'), { mirror: destination('one-to-one') });
  const live = new LiveConfig(configA);
  assert.equal(live.get(), configA);
  assert.equal(live.getSnapshot().configHash.length, 24);
  assert.ok(live.getSnapshot().loadedAt > 0);

  const configB = { ...configA, dest: {} };
  const previous = live.swap(configB);
  assert.equal(previous.config, configA);
  assert.equal(live.get(), configB);
  assert.notEqual(live.getSnapshot().configHash, previous.configHash);
});
