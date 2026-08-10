import { setTimeout as delay } from 'node:timers/promises';
import { apiHeaders } from '../git/auth.js';
import { AppError } from '../shared/errors.js';
import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';
import { requestJson, requestJsonWithRetry } from './http.js';
import type { CreateRepoInput, ListBranchCommitsInput, ProviderAdapter } from './provider.js';

interface GiteaRepositoryResponse {
  id: number;
  name: string;
  clone_url: string;
  html_url: string;
  owner: { login: string };
}

interface GiteaCommitListItem {
  commit?: { message?: string };
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

  async listBranchCommitMessages(input: ListBranchCommitsInput): Promise<string[]> {
    const messages: string[] = [];
    for (let page = 1; ; page += 1) {
      const remaining = input.maxCount - messages.length;
      if (remaining <= 0) break;
      const url = new URL(`${this.baseUrl}/api/v1/repos/${encodeURIComponent(input.locator.org)}/${encodeURIComponent(input.locator.repo)}/commits`);
      url.searchParams.set('sha', input.branch);
      url.searchParams.set('path', input.path);
      url.searchParams.set('limit', String(Math.min(remaining, 50)));
      url.searchParams.set('page', String(page));
      const response = await requestJsonWithRetry<GiteaCommitListItem[]>(url.toString(), {
        method: 'GET',
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
        expected: [200, 404],
      });
      if (response.status !== 200) break;
      const items = response.body ?? [];
      for (const item of items) {
        if (item?.commit?.message) messages.push(item.commit.message);
        if (messages.length >= input.maxCount) break;
      }
      if (items.length < 50) break;
      if ((input.apiDelayMs ?? 0) > 0) await delay(input.apiDelayMs);
    }
    return messages;
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
