import { setTimeout as delay } from 'node:timers/promises';
import { apiHeaders } from '../git/auth.js';
import { requestJson } from '../providers/http.js';
import type { CredentialConfig } from '../types.js';

export interface DiscoveredSourceRepository {
  provider: 'github';
  credentialId: string;
  credential: CredentialConfig;
  owner: string;
  repo: string;
  fullName: string;
  url: string;
  defaultBranch: string;
}

interface GitHubRepositoryListItem {
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  owner: { login: string };
}

interface GitHubCommitResponse {
  commit?: { message?: string };
}

function apiBase(credential: CredentialConfig): string {
  if (credential.apiBaseUrl) return credential.apiBaseUrl.replace(/\/$/, '');
  if (credential.baseUrl) return `${credential.baseUrl.replace(/\/$/, '')}/api/v3`;
  return 'https://api.github.com';
}

function headers(credential: CredentialConfig): Record<string, string> {
  return {
    ...apiHeaders(credential),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'git-mirror-sync-service',
  };
}

export async function discoverGithubRepositories(input: {
  credentialId: string;
  credential: CredentialConfig;
  apiTimeoutMs: number;
  apiDelayMs?: number;
}): Promise<DiscoveredSourceRepository[]> {
  const repositories: DiscoveredSourceRepository[] = [];
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const url = new URL(`${apiBase(input.credential)}/user/repos`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'full_name');
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
    const response = await requestJson<GitHubRepositoryListItem[]>(url.toString(), {
      method: 'GET',
      headers: headers(input.credential),
      timeoutMs: input.apiTimeoutMs,
      expected: [200],
    });
    const pageItems = response.body ?? [];
    for (const repository of pageItems) {
      if (!repository.full_name || !repository.clone_url || !repository.default_branch) continue;
      repositories.push({
        provider: 'github',
        credentialId: input.credentialId,
        credential: input.credential,
        owner: repository.owner?.login ?? repository.full_name.split('/')[0] ?? '',
        repo: repository.name,
        fullName: repository.full_name,
        url: repository.clone_url,
        defaultBranch: repository.default_branch,
      });
    }
    if (pageItems.length < perPage) break;
    if ((input.apiDelayMs ?? 0) > 0) await delay(input.apiDelayMs);
  }
  return repositories;
}

export async function getGithubCommitMessage(input: {
  repository: DiscoveredSourceRepository;
  sha: string;
  apiTimeoutMs: number;
}): Promise<string> {
  const { repository } = input;
  const response = await requestJson<GitHubCommitResponse>(
    `${apiBase(repository.credential)}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${encodeURIComponent(input.sha)}`,
    {
      method: 'GET',
      headers: headers(repository.credential),
      timeoutMs: input.apiTimeoutMs,
      expected: [200],
    },
  );
  return response.body?.commit?.message ?? '';
}
