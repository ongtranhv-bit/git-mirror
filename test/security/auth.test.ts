import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizationHeader, gitCredentialEnv } from '../../src/git/auth.js';
import { redactSecrets, registerSecret } from '../../src/shared/logger.js';

test('builds provider-specific headers', () => {
  assert.equal(buildAuthorizationHeader({ type: 'github', token: 'gh' }).value, `Basic ${Buffer.from('x-access-token:gh').toString('base64')}`);
  assert.equal(buildAuthorizationHeader({ type: 'github', token: 'gh' }, 'api').value, 'Bearer gh');
  assert.equal(buildAuthorizationHeader({ type: 'azure', token: 'az' }).value, `Basic ${Buffer.from(':az').toString('base64')}`);
  assert.equal(buildAuthorizationHeader({ type: 'gitea', token: 'gt' }, 'api').value, 'token gt');
});

test('git auth is injected through environment, not argv', () => {
  const env = gitCredentialEnv({ type: 'github', token: 'secret' }, {});
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  const header = env.GIT_CONFIG_VALUE_0 ?? '';
  assert.match(header, /^Authorization: Basic /);
  const encoded = header.replace(/^Authorization: Basic /, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'x-access-token:secret');
});

test('redacts registered secrets and authorization values', () => {
  registerSecret('super-secret-value');
  const output = redactSecrets('token=super-secret-value Authorization: Bearer abc123');
  assert.doesNotMatch(output, /super-secret-value|abc123/);
});
