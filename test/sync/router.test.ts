import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameRepository, resolveSourceFromHook } from '../../src/sync/router.js';
import { baseConfig, destination, hook } from '../helpers.js';

test('source URL, repo, ref and SHA come from hook data', () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one') });
  const event = hook('/tmp/source', 'app', 'abcdef1234567');
  const source = resolveSourceFromHook(config, event);
  assert.equal(source.fullName, 'source/app');
  assert.equal(source.url, event.url);
  assert.equal(source.ref, event.ref);
  assert.equal(source.sha, event.after);
  assert.equal(source.credential.token, 'source-secret');
});


test('sourceCredentialId selects the exact source credential when multiple credentials share a provider', () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one') });
  config.src.creds.secondary = { type: 'github', token: 'secondary-secret' };
  const event = hook('/tmp/source', 'app', 'abcdef1234567');
  event.sourceCredentialId = 'secondary';
  const source = resolveSourceFromHook(config, event);
  assert.equal(source.credential.token, 'secondary-secret');
});

test('sourceCredentialId rejects a credential with the wrong provider', () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one') });
  config.src.creds.other = { type: 'gitea', token: 'gitea-secret' };
  const event = hook('/tmp/source', 'app', 'abcdef1234567');
  event.sourceCredentialId = 'other';
  assert.throws(() => resolveSourceFromHook(config, event), /hook provider is github/);
});

test('rejects source URL containing credentials', () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one') });
  const event = hook('/tmp/source', 'app', 'abcdef1234567');
  event.url = 'https://user:token@example.com/repo.git';
  assert.throws(() => resolveSourceFromHook(config, event), /must not contain credentials/);
});

test('destination matching the source repository is detected as a self loop', () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one', 'app') });
  const source = resolveSourceFromHook(config, hook('/tmp/source', 'app', 'abcdef1234567'));
  assert.equal(isSameRepository('github', { org: 'source', repo: 'app' }, source), true);
  assert.equal(isSameRepository('github', { org: 'source', repo: 'other' }, source), false);
  assert.equal(isSameRepository('gitea', { org: 'source', repo: 'app' }, source), false);
});


test('worker applies repo filter centrally even for direct normalized events', async () => {
  const config = baseConfig('/tmp/test', { github: destination('one-to-one') });
  config.src.filter = { repo: { exclude: [{ mode: 'prefix', value: 'app' }] } };
  const event = hook('/tmp/source', 'application', 'abcdef1234567');
  const { processHookEvent } = await import('../../src/sync/router.js');
  const { createLogger } = await import('../../src/shared/logger.js');
  const result = await processHookEvent({ config, hook: event, instanceId: 'filter-worker', logger: createLogger('error') });
  assert.equal(result.destinations[0]?.status, 'skipped');
  assert.equal(result.destinations[0]?.error?.code, 'REPO_FILTERED');
});

test('targetDestinations limits processing to the requested destination ids', async () => {
  const config = baseConfig('/tmp/test', { first: destination('one-to-one'), second: destination('one-to-one') });
  const event = hook('/tmp/source', 'app', 'abcdef1234567');
  event.targetDestinations = ['second'];
  config.src.filter = { repo: { exclude: [{ mode: 'contains', value: 'app' }] } };
  const { processHookEvent } = await import('../../src/sync/router.js');
  const { createLogger } = await import('../../src/shared/logger.js');
  const result = await processHookEvent({ config, hook: event, instanceId: 'target-worker', logger: createLogger('error') });
  assert.deepEqual(result.destinations.map((item) => item.destinationId), ['second']);
});
