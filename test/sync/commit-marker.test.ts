import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncCommitMessage } from '../../src/git/directory-sync.js';
import { destination } from '../helpers.js';

test('commit message contains configured prefix and source markers', () => {
  const dest = destination('many-to-one');
  if (dest.mode !== 'many-to-one') throw new Error('invalid test destination');
  const message = buildSyncCommitMessage({
    commit: dest.commit,
    source: {
      provider: 'github',
      owner: 'acme',
      repo: 'app',
      fullName: 'acme/app',
      url: 'https://github.com/acme/app.git',
      ref: 'refs/heads/main',
      sha: 'abcdef1234567890',
      credential: { type: 'github', token: 'secret' },
    },
    commitInfo: {
      sha: 'abcdef1234567890',
      shortSha: 'abcdef1',
      subject: 'fix login',
      body: '',
      authorName: 'Test Author',
      authorEmail: 'test@example.com',
      authorDate: '2026-08-06T00:00:00.000Z',
      committerName: 'Test Author',
      committerEmail: 'test@example.com',
      committerDate: '2026-08-06T00:00:00.000Z',
    },
    sourceDirectory: 'apps/app',
    instanceId: 'worker-1',
    timestamp: '2026-08-06T00:00:00.000Z',
  });
  assert.match(message, /^\[sync\] app: fix login/);
  assert.match(message, /Source-Repo: acme\/app/);
  assert.match(message, /Source-Commit: abcdef1234567890/);
  assert.match(message, /Source-Directory: apps\/app/);
});
