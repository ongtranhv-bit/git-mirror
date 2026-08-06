import { apiHeaders } from '../git/auth.js';
import { AppError } from '../shared/errors.js';
import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';
import { requestJson } from './http.js';
import type { CreateRepoInput, ProviderAdapter } from './provider.js';

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  clone_url: string;
  html_url: string;
  owner: { login: string };
}

export class GitHubProvider implements ProviderAdapter {
  readonly destinationId: string;
  readonly config: DestinationConfig;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(destinationId: string, config: DestinationConfig, timeoutMs = 30_000) {
    this.destinationId = destinationId;
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.apiBase = config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/api/v3` : 'https://api.github.com';
  }

  async validateCredential(): Promise<void> {
    await requestJson(`${this.apiBase}/user`, {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      expected: [200],
    });
  }

  async getRepository(input: RepoLocator): Promise<RemoteRepository | null> {
    const response = await requestJson<GitHubRepositoryResponse>(
      `${this.apiBase}/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}`,
      { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200, 404] },
    );
    if (response.status === 404) return null;
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'GitHub returned an empty repository response.');
    return this.map(response.body);
  }

  async createRepository(input: CreateRepoInput): Promise<RemoteRepository> {
    const response = await requestJson<GitHubRepositoryResponse>(
      `${this.apiBase}/orgs/${encodeURIComponent(input.org)}/repos`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: input.repo, private: input.private, description: input.description }),
        timeoutMs: this.timeoutMs,
        expected: [201, 422],
      },
    );
    if (response.status === 422) {
      const existing = await this.getRepository(input);
      if (existing) return existing;
      throw new AppError('PROVIDER_CREATE_CONFLICT', `GitHub reported a conflict creating ${input.org}/${input.repo}.`);
    }
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'GitHub returned an empty create response.');
    return { ...this.map(response.body), created: true };
  }

  resolveCloneUrl(input: RepoLocator): string {
    const host = this.config.baseUrl?.replace(/\/$/, '') ?? 'https://github.com';
    return `${host}/${input.org}/${input.repo}.git`;
  }


  private headers(): Record<string, string> {
    return {
      ...apiHeaders(this.config.creds),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'git-mirror-sync-service',
    };
  }

  private map(repository: GitHubRepositoryResponse): RemoteRepository {
    return {
      id: String(repository.id),
      provider: 'github',
      org: repository.owner.login,
      repo: repository.name,
      cloneUrl: repository.clone_url,
      webUrl: repository.html_url,
    };
  }
}
