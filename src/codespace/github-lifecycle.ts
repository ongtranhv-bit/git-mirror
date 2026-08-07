import { AppError } from '../shared/errors.js';
import { registerSecret } from '../shared/logger.js';
import { requestJson } from '../providers/http.js';
import type { CodespaceInfo, CodespaceLifecycle, CodespaceMachine, CreateCodespaceInput } from './types.js';

interface GitHubCodespaceResponse {
  id?: number;
  name: string;
  state: string;
  owner?: { login?: string };
  repository: { full_name?: string; name?: string; owner?: { login?: string } };
  git_status?: { ref?: string };
  machine?: { name?: string };
  created_at?: string;
  updated_at?: string;
  display_name?: string;
}

export class GitHubCodespaceLifecycle implements CodespaceLifecycle {
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly token: string, timeoutMs = 30_000, apiBase = 'https://api.github.com') {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    registerSecret(token);
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const response = await requestJson<{ login?: string }>(`${this.apiBase}/user`, {
      method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200],
    });
    if (!response.body?.login) throw new AppError('CODESPACE_IDENTITY_INVALID', 'GitHub /user did not return login.');
    return { login: response.body.login };
  }

  async resolveRepositoryHead(owner: string, repo: string, branch: string): Promise<string> {
    const response = await requestJson<{ sha?: string }>(
      `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
      { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200] },
    );
    if (!response.body?.sha) throw new AppError('CODESPACE_REPO_HEAD_INVALID', 'GitHub did not return repository HEAD SHA.');
    return response.body.sha;
  }

  async listMachines(owner: string, repo: string): Promise<CodespaceMachine[]> {
    const response = await requestJson<{ machines?: Array<{ name?: string; display_name?: string; cpus?: number; memory_in_bytes?: number; storage_in_bytes?: number }> }>(
      `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/codespaces/machines`,
      { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200] },
    );
    return (response.body?.machines ?? []).flatMap((machine) => machine.name ? [{
      name: machine.name,
      ...(machine.display_name ? { displayName: machine.display_name } : {}),
      ...(machine.cpus !== undefined ? { cpus: machine.cpus } : {}),
      ...(machine.memory_in_bytes !== undefined ? { memoryInBytes: machine.memory_in_bytes } : {}),
      ...(machine.storage_in_bytes !== undefined ? { storageInBytes: machine.storage_in_bytes } : {}),
    }] : []);
  }


  async list(): Promise<CodespaceInfo[]> {
    const all: CodespaceInfo[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await requestJson<{ codespaces?: GitHubCodespaceResponse[] }>(`${this.apiBase}/user/codespaces?per_page=100&page=${page}`, {
        method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200],
      });
      const items = response.body?.codespaces ?? [];
      all.push(...items.map((item) => this.mapRequired(item, 'list')));
      if (items.length < 100) break;
    }
    return all;
  }

  async create(input: CreateCodespaceInput): Promise<CodespaceInfo> {
    const body: Record<string, unknown> = { ref: input.branch };
    if (input.machine) body.machine = input.machine;
    if (input.devcontainerPath) body.devcontainer_path = input.devcontainerPath;
    if (input.displayName) body.display_name = input.displayName;
    if (input.idleTimeoutMinutes !== undefined) body.idle_timeout_minutes = input.idleTimeoutMinutes;
    if (input.retentionPeriodMinutes !== undefined) body.retention_period_minutes = input.retentionPeriodMinutes;
    const response = await requestJson<GitHubCodespaceResponse>(
      `${this.apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/codespaces`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), timeoutMs: this.timeoutMs, expected: [201, 202] },
    );
    return this.mapRequired(response.body, 'create');
  }

  async get(name: string): Promise<CodespaceInfo> {
    const response = await requestJson<GitHubCodespaceResponse>(`${this.apiBase}/user/codespaces/${encodeURIComponent(name)}`, {
      method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200],
    });
    return this.mapRequired(response.body, 'get');
  }

  async start(name: string): Promise<CodespaceInfo> {
    const response = await requestJson<GitHubCodespaceResponse>(`${this.apiBase}/user/codespaces/${encodeURIComponent(name)}/start`, {
      method: 'POST', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200],
    });
    return this.mapRequired(response.body, 'start');
  }

  async stop(name: string): Promise<CodespaceInfo> {
    const response = await requestJson<GitHubCodespaceResponse>(`${this.apiBase}/user/codespaces/${encodeURIComponent(name)}/stop`, {
      method: 'POST', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200],
    });
    return this.mapRequired(response.body, 'stop');
  }

  async delete(name: string): Promise<void> {
    await requestJson<unknown>(`${this.apiBase}/user/codespaces/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [202],
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': process.env.GH_CODESPACE_API_VERSION ?? '2026-03-10',
      'Content-Type': 'application/json',
      'User-Agent': 'git-mirror-sync-service',
    };
  }

  private mapRequired(body: GitHubCodespaceResponse | null, operation: string): CodespaceInfo {
    if (!body?.name || !body.state || !body.repository) {
      throw new AppError('CODESPACE_RESPONSE_INVALID', `GitHub Codespaces ${operation} returned incomplete data.`);
    }
    const repository = body.repository.full_name
      ?? [body.repository.owner?.login, body.repository.name].filter(Boolean).join('/');
    if (!repository) throw new AppError('CODESPACE_RESPONSE_INVALID', 'Codespace response has no repository identity.');
    return {
      name: body.name,
      ...(body.id !== undefined ? { id: body.id } : {}),
      state: body.state,
      repository,
      ...(body.git_status?.ref ? { branch: body.git_status.ref.replace(/^refs\/heads\//, '') } : {}),
      ...(body.machine?.name ? { machine: body.machine.name } : {}),
      ...(body.owner?.login ? { ownerLogin: body.owner.login } : {}),
      ...(body.created_at ? { createdAt: body.created_at } : {}),
      ...(body.updated_at ? { updatedAt: body.updated_at } : {}),
      ...(body.display_name ? { displayName: body.display_name } : {}),
    };
  }
}
