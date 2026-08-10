import { setTimeout as delay } from 'node:timers/promises';
import { apiHeaders } from '../git/auth.js';
import { AppError } from '../shared/errors.js';
import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';
import { requestJson, requestJsonWithRetry } from './http.js';
import type { CreateRepoInput, ListBranchCommitsInput, ProviderAdapter } from './provider.js';

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  clone_url: string;
  html_url: string;
  owner: { login: string };
}

interface GitHubCommitListItem {
  commit?: { message?: string };
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
    await this.authenticatedUser();
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
    const orgResponse = await requestJson<GitHubRepositoryResponse>(
      `${this.apiBase}/orgs/${encodeURIComponent(input.org)}/repos`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: input.repo, private: input.private, description: input.description }),
        timeoutMs: this.timeoutMs,
        expected: [201, 422, 404],
      },
    );
    if (orgResponse.status === 404) {
      const user = await this.authenticatedUser();
      if (user.login !== input.org) {
        throw new AppError(
          'PROVIDER_CREATE_FORBIDDEN',
          `Cannot create ${input.org}/${input.repo}: ${input.org} is not an accessible organization or the authenticated user.`,
          { retryable: false },
        );
      }
      return this.createForAuthenticatedUser(input);
    }
    if (orgResponse.status === 422) {
      const existing = await this.getRepository(input);
      if (existing) return existing;
      throw new AppError('PROVIDER_CREATE_CONFLICT', `GitHub reported a conflict creating ${input.org}/${input.repo}.`);
    }
    if (!orgResponse.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'GitHub returned an empty create response.');
    return { ...this.map(orgResponse.body), created: true };
  }

  resolveCloneUrl(input: RepoLocator): string {
    const host = this.config.baseUrl?.replace(/\/$/, '') ?? 'https://github.com';
    return `${host}/${input.org}/${input.repo}.git`;
  }

  async listBranchCommitMessages(input: ListBranchCommitsInput): Promise<string[]> {
    const messages: string[] = [];
    for (let page = 1; ; page += 1) {
      const remaining = input.maxCount - messages.length;
      if (remaining <= 0) break;
      const url = new URL(`${this.apiBase}/repos/${encodeURIComponent(input.locator.org)}/${encodeURIComponent(input.locator.repo)}/commits`);
      url.searchParams.set('sha', input.branch);
      url.searchParams.set('path', input.path);
      url.searchParams.set('per_page', String(Math.min(remaining, 100)));
      url.searchParams.set('page', String(page));
      const response = await requestJsonWithRetry<GitHubCommitListItem[]>(url.toString(), {
        method: 'GET',
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
        expected: [200, 404, 409],
      });
      if (response.status !== 200) break;
      const items = response.body ?? [];
      for (const item of items) {
        if (item?.commit?.message) messages.push(item.commit.message);
        if (messages.length >= input.maxCount) break;
      }
      if (items.length < 100) break;
      if ((input.apiDelayMs ?? 0) > 0) await delay(input.apiDelayMs);
    }
    return messages;
  }


  private async authenticatedUser(): Promise<{ login: string }> {
    const response = await requestJson<{ login: string }>(`${this.apiBase}/user`, {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      expected: [200],
    });
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'GitHub returned an empty user response.');
    return response.body;
  }

  private async createForAuthenticatedUser(input: CreateRepoInput): Promise<RemoteRepository> {
    const response = await requestJson<GitHubRepositoryResponse>(
      `${this.apiBase}/user/repos`,
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
