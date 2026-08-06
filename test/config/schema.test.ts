import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config/schema.js';
import { ConfigValidationError } from '../../src/shared/errors.js';

function validConfig(): Record<string, unknown> {
  return {
    configVersion: 6,
    src: { creds: { github: { type: 'github', token: 'source-token' } } },
    dest: {
      github: {
        type: 'github',
        mode: 'one-to-one',
        creds: { type: 'github', token: 'dest-token' },
        org: 'mirror',
        repo: '{sourceRepo}',
      },
      azure: {
        type: 'azure',
        mode: 'one-to-one',
        creds: { type: 'azure', token: 'azure-token' },
        org: 'acme',
        project: 'platform',
        repo: '{sourceRepo}',
      },
    },
  };
}

test('parses inline destination credentials and defaults', () => {
  const config = parseConfig(validConfig());
  assert.equal(config.dest.github?.creds.token, 'dest-token');
  assert.equal(config.dest.github?.mode, 'one-to-one');
  assert.equal(config.runtime.lockTtlSeconds, 900);
});

test('rejects source url/repo fields because hook owns source metadata', () => {
  const input = validConfig();
  input.src = { ...(input.src as object), url: 'https://example.com/a.git', repo: 'a' };
  assert.throws(() => parseConfig(input), (error: unknown) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.match(error.message, /src only accepts the creds field/);
    return true;
  });
});

test('rejects destination without inline creds', () => {
  const input = validConfig();
  delete ((input.dest as Record<string, Record<string, unknown>>).github ?? {}).creds;
  assert.throws(() => parseConfig(input), /\.dest\.github\.creds/);
});

test('rejects Azure without project', () => {
  const input = validConfig();
  delete ((input.dest as Record<string, Record<string, unknown>>).azure ?? {}).project;
  assert.throws(() => parseConfig(input), /required for Azure DevOps/);
});
