import { AppError } from '../shared/errors.js';

export interface RunnerIdentity {
  provider: 'github' | 'azure' | 'manual';
  owner: string;
  repo: string;
  workflowFile?: string;
  /** Human-readable identity used as RTDB key namespace. */
  key: string;
  displayName: string;
}

export interface ResolveRunnerIdentityOptions {
  env?: NodeJS.ProcessEnv;
  registryDisabled?: boolean;
}

export function resolveRunnerIdentity(options: ResolveRunnerIdentityOptions = {}): RunnerIdentity | null {
  const env = options.env ?? process.env;
  if (options.registryDisabled ?? env.RUNNER_REGISTRY_DISABLED === '1') return null;

  const manualKey = env.RUNNER_KEY?.trim();
  if (manualKey) {
    return {
      provider: 'manual',
      owner: 'manual',
      repo: manualKey,
      key: `manual:${manualKey}`,
      displayName: `manual:${manualKey}`,
    };
  }

  if (env.GITHUB_ACTIONS === 'true') {
    const github = identityFromGithub(env);
    if (github) return github;
  }

  if (env.TF_BUILD === 'true' || env.AZURE_PIPELINES === 'true') {
    const azure = identityFromAzure(env);
    if (azure) return azure;
  }

  return null;
}

export function identityFromGithub(env: NodeJS.ProcessEnv): RunnerIdentity | null {
  const workflowRef = env.GITHUB_WORKFLOW_REF?.trim();
  if (workflowRef) {
    const match = /^([^/]+)\/([^/]+)\/\.github\/workflows\/([^@]+)@.+$/.exec(workflowRef);
    if (match) {
      const [, owner, repo, file] = match;
      const workflowFile = (file ?? '').trim() || 'workflow';
      return githubIdentity(owner ?? '', repo ?? '', workflowFile);
    }
  }
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (repository && /^[^/]+\/[^/]+$/.test(repository)) {
    const [owner, repo] = repository.split('/');
    return githubIdentity(owner ?? '', repo ?? '', env.GITHUB_WORKFLOW?.trim() || 'workflow');
  }
  return null;
}

function githubIdentity(owner: string, repo: string, workflowFile: string): RunnerIdentity {
  return {
    provider: 'github',
    owner,
    repo,
    workflowFile,
    key: `github:${owner}/${repo}:${workflowFile}`,
    displayName: `${owner}/${repo} (${workflowFile})`,
  };
}

export function identityFromAzure(env: NodeJS.ProcessEnv): RunnerIdentity | null {
  const uriOwnerRepo = repoOwnerFromUri(env.BUILD_REPOSITORY_URI);
  const owner = uriOwnerRepo?.owner ?? env.SYSTEM_TEAMPROJECT?.trim() ?? 'unknown';
  const repo = uriOwnerRepo?.repo ?? env.BUILD_REPOSITORY_NAME?.trim() ?? 'unknown';
  const ymlFile = env.RUNNER_WORKFLOW_FILE?.trim();
  const pipelineId = env.SYSTEM_PIPELINEID?.trim() ?? env.SYSTEM_DEFINITIONID?.trim() ?? env.BUILD_DEFINITIONID?.trim();
  const workflowFile = ymlFile ?? `pipeline:${pipelineId ?? 'unknown'}`;
  const project = env.SYSTEM_TEAMPROJECT?.trim();
  return {
    provider: 'azure',
    owner,
    repo,
    workflowFile,
    key: `azure:${project ? `${project}/` : ''}${owner}/${repo}:${workflowFile}`,
    displayName: `${project ? `${project}/` : ''}${owner}/${repo} (${workflowFile})`,
  };
}

function repoOwnerFromUri(uri: string | undefined): { owner: string; repo: string } | null {
  if (!uri?.trim()) return null;
  try {
    const url = new URL(uri);
    const segments = url.pathname.split('/').filter(Boolean).map((segment) => segment.replace(/\.git$/, ''));
    if (segments.length === 0) return null;
    if (segments.at(-2) === '_git') {
      return { owner: segments.at(-3) ?? '', repo: segments.at(-1) ?? '' };
    }
    if (segments.length >= 2) {
      return { owner: segments.at(-2) ?? '', repo: segments.at(-1) ?? '' };
    }
    return { owner: '', repo: segments.at(-1) ?? '' };
  } catch (error) {
    throw new AppError('RUNNER_URI_INVALID', `BUILD_REPOSITORY_URI is not a valid URL: ${uri}`, { cause: error });
  }
}
