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

test('GitHub adapter creates repository under the authenticated user when org endpoint 404s', async () => {
  const dest = destination('one-to-one', 'app');
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/user') && init?.method !== 'POST') {
      return new Response(JSON.stringify({ login: 'code-dh-1007' }), { status: 200 });
    }
    if (url.endsWith('/orgs/code-dh-1007/repos') && init?.method === 'POST') {
      return new Response('{}', { status: 404 });
    }
    if (url.endsWith('/user/repos') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({ id: 2, name: 'app', clone_url: 'https://github.com/code-dh-1007/app.git', html_url: 'https://github.com/code-dh-1007/app', owner: { login: 'code-dh-1007' } }),
        { status: 201 },
      );
    }
    return new Response('null', { status: 404 });
  };
  try {
    const provider = new GitHubProvider('github', dest);
    const created = await provider.createRepository({ org: 'code-dh-1007', repo: 'app', private: true });
    assert.equal(created.created, true);
    assert.equal(created.org, 'code-dh-1007');
    assert.ok(requests.some((item) => item.url.endsWith('/orgs/code-dh-1007/repos')));
    assert.ok(requests.some((item) => item.url.endsWith('/user/repos')));
  } finally {
    globalThis.fetch = original;
  }
});

test('GitHub adapter rejects user-account creation when namespace is not the authenticated user', async () => {
  const dest = destination('one-to-one', 'app');
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/user') && init?.method !== 'POST') {
      return new Response(JSON.stringify({ login: 'someone-else' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const provider = new GitHubProvider('github', dest);
    await assert.rejects(
      () => provider.createRepository({ org: 'code-dh-1007', repo: 'app', private: true }),
      /not an accessible organization or the authenticated user/,
    );
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
