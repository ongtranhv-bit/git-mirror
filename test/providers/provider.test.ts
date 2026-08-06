import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubProvider } from '../../src/providers/github.js';
import { AzureProvider } from '../../src/providers/azure.js';
import { destination } from '../helpers.js';

test('GitHub adapter checks and creates repository with inline credential', async () => {
  const dest = destination('one-to-one', 'app');
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/user')) return new Response('{}', { status: 200 });
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({ id: 1, name: 'app', clone_url: 'https://github.com/mirror/app.git', html_url: 'https://github.com/mirror/app', owner: { login: 'mirror' } }),
        { status: 201 },
      );
    }
    return new Response('null', { status: 404 });
  };
  try {
    const provider = new GitHubProvider('github', dest);
    await provider.validateCredential();
    assert.equal(await provider.getRepository({ org: 'mirror', repo: 'app' }), null);
    const created = await provider.createRepository({ org: 'mirror', repo: 'app', private: true });
    assert.equal(created.created, true);
    assert.match(String(requests[0]?.init?.headers && JSON.stringify(requests[0]?.init?.headers)), /Bearer destination-secret/);
    assert.doesNotMatch(requests.map((item) => item.url).join('\n'), /destination-secret/);
  } finally {
    globalThis.fetch = original;
  }
});

test('Azure adapter strips userinfo from repository remoteUrl', async () => {
  const dest = destination('one-to-one', 'app');
  const azure = {
    ...dest,
    type: 'azure' as const,
    org: 'asregister',
    project: 'o22zalo',
    baseUrl: 'https://dev.azure.com',
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('?api-version=7.1')) {
      return new Response(
        JSON.stringify({
          id: 'repo-1',
          name: 'app',
          remoteUrl: 'https://asregister@dev.azure.com/asregister/o22zalo/_git/app',
          webUrl: 'https://dev.azure.com/asregister/o22zalo/_git/app',
          project: { id: 'proj-1', name: 'o22zalo' },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const provider = new AzureProvider('azure', azure);
    const repo = await provider.getRepository({ org: 'asregister', repo: 'app' });
    assert.ok(repo);
    assert.equal(repo.cloneUrl, 'https://dev.azure.com/asregister/o22zalo/_git/app');
    assert.doesNotMatch(repo.cloneUrl, /asregister@/);
  } finally {
    globalThis.fetch = original;
  }
});
