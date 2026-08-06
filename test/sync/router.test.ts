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
