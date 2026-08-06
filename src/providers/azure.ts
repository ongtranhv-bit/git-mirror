import { apiHeaders } from '../git/auth.js';
import { AppError } from '../shared/errors.js';
import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';
import { requestJson } from './http.js';
import type { CreateRepoInput, ProviderAdapter } from './provider.js';

interface AzureRepositoryResponse {
  id: string;
  name: string;
  remoteUrl: string;
  webUrl: string;
  project: { id: string; name: string };
}

function stripUrlUserinfo(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

export class AzureProvider implements ProviderAdapter {
  readonly destinationId: string;
  readonly config: DestinationConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(destinationId: string, config: DestinationConfig, timeoutMs = 30_000) {
    this.destinationId = destinationId;
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.baseUrl = config.baseUrl?.replace(/\/$/, '') ?? 'https://dev.azure.com';
    if (!config.project) throw new AppError('CONFIG_INVALID', `Azure destination ${destinationId} requires project.`);
  }

  async validateCredential(): Promise<void> {
    await requestJson(this.repositoriesUrl(this.config.org, this.config.project ?? ''), {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
      expected: [200],
    });
  }

  async getRepository(input: RepoLocator): Promise<RemoteRepository | null> {
    const project = input.project ?? this.config.project;
    if (!project) throw new AppError('CONFIG_INVALID', 'Azure repository lookup requires project.');
    const response = await requestJson<AzureRepositoryResponse>(
      `${this.repositoriesUrl(input.org, project)}/${encodeURIComponent(input.repo)}?api-version=7.1`,
      { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs, expected: [200, 404] },
    );
    if (response.status === 404) return null;
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'Azure returned an empty repository response.');
    return this.map(response.body, input.org);
  }

  async createRepository(input: CreateRepoInput): Promise<RemoteRepository> {
    const project = input.project ?? this.config.project;
    if (!project) throw new AppError('CONFIG_INVALID', 'Azure repository creation requires project.');
    const response = await requestJson<AzureRepositoryResponse>(
      `${this.repositoriesUrl(input.org, project)}?api-version=7.1`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name: input.repo }),
        timeoutMs: this.timeoutMs,
        expected: [201, 409],
      },
    );
    if (response.status === 409) {
      const existing = await this.getRepository(input);
      if (existing) return existing;
      throw new AppError('PROVIDER_CREATE_CONFLICT', `Azure reported a conflict creating ${input.org}/${project}/${input.repo}.`);
    }
    if (!response.body) throw new AppError('PROVIDER_RESPONSE_INVALID', 'Azure returned an empty create response.');
    return { ...this.map(response.body, input.org), created: true };
  }

  resolveCloneUrl(input: RepoLocator): string {
    const project = input.project ?? this.config.project;
    if (!project) throw new AppError('CONFIG_INVALID', 'Azure clone URL requires project.');
    return `${this.baseUrl}/${input.org}/${project}/_git/${input.repo}`;
  }

  private repositoriesUrl(org: string, project: string): string {
    return `${this.baseUrl}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories`;
  }


  private headers(): Record<string, string> {
    return { ...apiHeaders(this.config.creds), 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private map(repository: AzureRepositoryResponse, org: string): RemoteRepository {
    return {
      id: repository.id,
      provider: 'azure',
      org,
      project: repository.project.name,
      repo: repository.name,
      cloneUrl: stripUrlUserinfo(repository.remoteUrl),
      webUrl: repository.webUrl,
    };
  }
}
