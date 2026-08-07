import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCodespaceLifecycle } from '../../src/codespace/github-lifecycle.js';

test('GitHub Codespaces lifecycle maps identity, head, machines, list and lifecycle endpoints without token in URL', async () => {
  const requests: Array<{ url: string; method: string; body?: string; apiVersion?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(headers.get('X-GitHub-Api-Version') ? { apiVersion: headers.get('X-GitHub-Api-Version') ?? undefined } : {}),
    });
    if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'owner07' }), { status: 200 });
    if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: 'abc123' }), { status: 200 });
    if (url.includes('/codespaces/machines')) {
      return new Response(JSON.stringify({ machines: [{ name: 'standardLinux', display_name: 'Standard', cpus: 4 }] }), { status: 200 });
    }
    if (url.includes('/user/codespaces?')) {
      return new Response(JSON.stringify({ codespaces: [{
        id: 1, name: 'cs-existing', state: 'Available', display_name: 'git-mirror-2026-08-07',
        owner: { login: 'owner07' }, repository: { full_name: 'org/runner' }, git_status: { ref: 'refs/heads/main' },
      }] }), { status: 200 });
    }
    if (url.endsWith('/repos/org/runner/codespaces') && method === 'POST') {
      return new Response(JSON.stringify({
        id: 2, name: 'cs-new', state: 'Queued', display_name: 'git-mirror-2026-08-07',
        owner: { login: 'owner07' }, repository: { full_name: 'org/runner' }, git_status: { ref: 'refs/heads/main' },
      }), { status: 201 });
    }
    if (url.endsWith('/start') || url.endsWith('/stop')) {
      return new Response(JSON.stringify({ name: 'cs-new', state: url.endsWith('/start') ? 'Starting' : 'Shutdown', owner: { login: 'owner07' }, repository: { full_name: 'org/runner' } }), { status: 200 });
    }
    if (url.endsWith('/user/codespaces/cs-new') && method === 'DELETE') return new Response(null, { status: 202 });
    if (url.endsWith('/user/codespaces/cs-new')) {
      return new Response(JSON.stringify({ name: 'cs-new', state: 'Available', owner: { login: 'owner07' }, repository: { full_name: 'org/runner' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const lifecycle = new GitHubCodespaceLifecycle('super-secret', 5_000);
    assert.deepEqual(await lifecycle.getAuthenticatedUser(), { login: 'owner07' });
    assert.equal(await lifecycle.resolveRepositoryHead('org', 'runner', 'main'), 'abc123');
    assert.deepEqual((await lifecycle.listMachines('org', 'runner')).map((item) => item.name), ['standardLinux']);
    assert.equal((await lifecycle.list())[0]?.displayName, 'git-mirror-2026-08-07');
    const created = await lifecycle.create({ owner: 'org', repo: 'runner', branch: 'main', machine: 'standardLinux', displayName: 'git-mirror-2026-08-07', retentionPeriodMinutes: 1440 });
    assert.equal(created.name, 'cs-new');
    assert.equal((await lifecycle.get('cs-new')).state, 'Available');
    await lifecycle.start('cs-new');
    await lifecycle.stop('cs-new');
    await lifecycle.delete('cs-new');
    assert.doesNotMatch(requests.map((item) => item.url).join('\n'), /super-secret/);
    assert.match(requests.find((item) => item.url.endsWith('/repos/org/runner/codespaces'))?.body ?? '', /"retention_period_minutes":1440/);
    assert.ok(requests.every((item) => item.apiVersion === '2026-03-10'));
  } finally {
    globalThis.fetch = original;
  }
});
