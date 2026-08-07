import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLifecycleToken } from '../../src/codespace/credentials.js';

test('lifecycle token can resolve from a single base64 credential map for scheduler use', () => {
  const encoded = Buffer.from(JSON.stringify({ TOKEN_07: 'seven', OLD_TOKEN: 'old' })).toString('base64');
  assert.equal(resolveLifecycleToken('TOKEN_07', { CODESPACE_LIFECYCLE_TOKENS_B64: encoded }), 'seven');
  assert.equal(resolveLifecycleToken('OLD_TOKEN', { CODESPACE_LIFECYCLE_TOKENS_B64: encoded }), 'old');
});
