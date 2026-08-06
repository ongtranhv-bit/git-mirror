import { apiHeaders } from '../git/auth.js';
import { AppError } from '../shared/errors.js';
import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';
import { requestJson } from './http.js';
import type { CreateRepoInput, ProviderAdapter } from './provider.js';

interface GiteaRepositoryResponse {
  id: number;
  name: string;
  clone_url: string;
  html_url: string;
  owner: { login: string };
}

export class GiteaProvider implements ProviderAdapter {
  readonly destinationId: string;
  readonly config: DestinationConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(destinationId: string, config: DestinationConfig, timeoutMs = 30_000) {
    this.destinationId = destinationId;
    this.config = config;
    this.timeoutMs = timeoutMs;
    if (!config.baseUrl) throw new AppError('CONFIG_INVALID', `Gitea destination ${destinationId} requires baseUrl.`);
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async validateCredential(): Promise<void> {
    await requestJson(`${this.baseUrl}/api/v1/user`, {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      expected: [200],
    });
  }

  async getRepository(input: RepoLocator): Promise<RemoteRepository | null> {
    const response = await requestJson<GiteaRepositoryResponse>(
      `${this.baseUrl}/api/v1/repos/${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}`,
      { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200, 404] },
    );
    if (response.status === 404) return null;
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'Gitea returned an empty repository response.');
    return this.map(response.body);
  }

  async createRepository(input: CreateRepoInput): Promise<RemoteRepository> {
    const response = await requestJson<GiteaRepositoryResponse>(
      `${this.baseUrl}/api/v1/orgs/${encodeURIComponent(input.org)}/repos`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: input.repo, private: input.private, description: input.description }),
        timeoutMs: this.timeoutMs,
        expected: [201, 409, 422],
      },
    );
    if (response.status === 409 || response.status === 422) {
      const existing = await this.getRepository(input);
      if (existing) return existing;
      throw new AppError('PROVIDER_CREATE_CONFLICT', `Gitea reported a conflict creating ${input.org}/${input.repo}.`);
    }
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'Gitea returned an empty create response.');
    return { ...this.map(response.body), created: true };
  }

  resolveCloneUrl(input: RepoLocator): string {
    return `${this.baseUrl}/${input.org}/${input.repo}.git`;
  }


  private headers(): Record<string, string> {
    return { ...apiHeaders(this.config.creds), 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private map(repository: GiteaRepositoryResponse): RemoteRepository {
    return {
      id: String(repository.id),
      provider: 'gitea',
      org: repository.owner.login,
      repo: repository.name,
      cloneUrl: repository.clone_url,
      webUrl: repository.html_url,
    };
  }
}
