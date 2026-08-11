import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createProviderAdapter } from '../providers/factory.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { RtdbClient } from '../rtdb/client.js';
import { isExcludedCommit, isExcludedRepo } from '../filter.js';
import { ensureDestinationWorkspace, ensureSourceWorkspace } from '../git/workspace.js';
import { runGit } from '../git/workspace.js';
import { directoryTreeMatchesCommit } from '../git/directory-sync.js';
import { listRemoteRefs } from '../git/remote-refs.js';
import { refsForPushPolicy } from '../git/mirror.js';
import { stableHash, sanitizeRtdbKey } from '../shared/paths.js';
import { acquireDestinationLock, isLockStale, refreshLock, releaseDestinationLock, type LockRecord } from '../rtdb/locks.js';
import { AppError, toPublicError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { isSameRepository, render, resolveDirectory } from '../sync/router.js';
import type { AppConfig, CommitConfig, DestinationConfig, HookEvent, RepoLocator, SourceRepository } from '../types.js';
import { discoverGithubRepositories, getGithubCommitMessage, type DiscoveredSourceRepository } from './github-source.js';

const RECONCILE_COMMIT_SCAN_LIMIT = 200;

export interface DestinationDrift {
  destinationId: string;
  status: 'in-sync' | 'drift' | 'skipped' | 'error';
  reason?: string;
  error?: ReturnType<typeof toPublicError>;
}

export interface RepositoryReconcileResult {
  sourceRepo: string;
  ref?: string;
  sha?: string;
  status: 'in-sync' | 'queued' | 'would-queue' | 'filtered' | 'empty' | 'error';
  queueStatus?: 'queued' | 'already-pending';
  eventId?: string;
  targetDestinations?: string[];
  destinations?: DestinationDrift[];
  error?: ReturnType<typeof toPublicError>;
}

export interface ManualReconcileResult {
  scanned: number;
  sourceTotal: number;
  sourceSelected: number;
  destinationChecksTotal: number;
  destinationExisting: number;
  destinationMissing: number;
  needsReconcile: number;
  valid: number;
  invalid: number;
  queued: number;
  wouldQueue: number;
  inSync: number;
  filtered: number;
  empty: number;
  errors: number;
  destinationErrors: number;
  repositories: RepositoryReconcileResult[];
}

export async function reconcileRepositories(input: {
  config: AppConfig;
  client: RtdbClient;
  logger: Logger;
  dryRun?: boolean;
  sourceCredentialId?: string;
  orgs?: string[];
  owners?: string[];
  repos?: string[];
  destinations?: string[];
  repoDelayMs?: number;
  apiDelayMs?: number;
  adapters?: Record<string, ProviderAdapter>;
  discoveredRepositories?: DiscoveredSourceRepository[];
}): Promise<ManualReconcileResult> {
  const lockKey = 'manual-reconcile';
  const owner = `reconcile-${process.pid}-${stableHash(`${Date.now()}:${Math.random()}`)}`;
  const lockPath = `${input.config.rtdb.locksPath}/${sanitizeRtdbKey(lockKey)}`;
  const existingLock = await input.client.get<LockRecord>(lockPath);
  if (existingLock) {
    const now = Date.now();
    input.logger.info(
      {
        owner: existingLock.owner,
        heartbeatAgeMs: now - Number(existingLock.heartbeatAt ?? existingLock.claimedAt),
        expiresInMs: existingLock.expiresAt - now,
        stale: isLockStale(existingLock, input.config.runtime.lockTtlSeconds, now),
      },
      'reconcile.lock_observed',
    );
  }
  const locked = await acquireDestinationLock(
    input.client,
    input.config.rtdb.locksPath,
    lockKey,
    owner,
    input.config.runtime.lockTtlSeconds,
  );
  if (!locked) {
    throw new AppError('RECONCILE_ALREADY_RUNNING', 'Another manual reconcile run currently holds the RTDB reconcile lock.', { retryable: true });
  }
  const heartbeat = setInterval(
    () => void refreshLock(input.client, lockPath, owner, input.config.runtime.lockTtlSeconds)
      .catch((error) => input.logger.warn({ error: toPublicError(error) }, 'reconcile.lock_heartbeat_failed')),
    Math.max(1_000, Math.floor((input.config.runtime.lockTtlSeconds * 1_000) / 3)),
  );
  heartbeat.unref();
  try {
    return await reconcileRepositoriesLocked(input);
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseDestinationLock(input.client, input.config.rtdb.locksPath, lockKey, owner);
    } catch (error) {
      input.logger.warn({ error: toPublicError(error) }, 'reconcile.lock_release_failed');
    }
  }
}

async function reconcileRepositoriesLocked(input: {
  config: AppConfig;
  client: RtdbClient;
  logger: Logger;
  dryRun?: boolean;
  sourceCredentialId?: string;
  orgs?: string[];
  owners?: string[];
  repos?: string[];
  destinations?: string[];
  repoDelayMs?: number;
  apiDelayMs?: number;
  adapters?: Record<string, ProviderAdapter>;
  discoveredRepositories?: DiscoveredSourceRepository[];
}): Promise<ManualReconcileResult> {
  const repositories = input.discoveredRepositories ?? await discoverSources(input);
  const ownerFilter = new Set((input.owners ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
  const repoFilter = new Set((input.repos ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
  const destinationFilter = input.destinations ? new Set(input.destinations) : undefined;
  const selected = repositories.filter((repository) => {
    if (ownerFilter.size > 0 && !ownerFilter.has(repository.owner.toLowerCase())) return false;
    if (repoFilter.size === 0) return true;
    return repoFilter.has(repository.repo.toLowerCase()) || repoFilter.has(repository.fullName.toLowerCase());
  });

  const result: ManualReconcileResult = {
    scanned: 0,
    sourceTotal: repositories.length,
    sourceSelected: selected.length,
    destinationChecksTotal: 0,
    destinationExisting: 0,
    destinationMissing: 0,
    needsReconcile: 0,
    valid: 0,
    invalid: 0,
    queued: 0,
    wouldQueue: 0,
    inSync: 0,
    filtered: 0,
    empty: 0,
    errors: 0,
    destinationErrors: 0,
    repositories: [],
  };
  const destinationWorkspaceCache = new Map<string, Promise<string>>();

  for (const repository of selected) {
    result.scanned += 1;
    input.logger.info({ sourceRepo: repository.fullName, defaultBranch: repository.defaultBranch }, 'reconcile.repo_started');
    const item = await reconcileRepository({ ...input, repository, destinationFilter, destinationWorkspaceCache });
    input.logger.info(
      {
        sourceRepo: repository.fullName,
        status: item.status,
        ref: item.ref,
        sha: item.sha,
        eventId: item.eventId,
        targetDestinations: item.targetDestinations,
        error: item.error,
      },
      'reconcile.repo_done',
    );
    result.repositories.push(item);
    if (item.status === 'queued') result.queued += 1;
    else if (item.status === 'would-queue') result.wouldQueue += 1;
    else if (item.status === 'in-sync') result.inSync += 1;
    else if (item.status === 'filtered') result.filtered += 1;
    else if (item.status === 'empty') result.empty += 1;
    else if (item.status === 'error') result.errors += 1;
    result.destinationErrors += item.destinations?.filter((destination) => destination.status === 'error').length ?? 0;
    for (const destination of item.destinations ?? []) {
      if (destination.status === 'skipped') continue;
      result.destinationChecksTotal += 1;
      if (destination.reason === 'destination-missing') result.destinationMissing += 1;
      else if (destination.status !== 'error') result.destinationExisting += 1;
      if (destination.status === 'in-sync') result.valid += 1;
      else if (destination.status === 'drift' || destination.status === 'error') result.invalid += 1;
      if (destination.status === 'drift') result.needsReconcile += 1;
    }
    if ((input.repoDelayMs ?? 0) > 0) await delay(input.repoDelayMs);
  }
  return result;
}

async function discoverSources(input: {
  config: AppConfig;
  logger: Logger;
  sourceCredentialId?: string;
  orgs?: string[];
  apiDelayMs?: number;
}): Promise<DiscoveredSourceRepository[]> {
  const entries = Object.entries(input.config.src.creds).filter(([id, credential]) => {
    if (input.sourceCredentialId && id !== input.sourceCredentialId) return false;
    return credential.type === 'github';
  });
  if (entries.length === 0) {
    throw new Error(input.sourceCredentialId
      ? `Source credential ${input.sourceCredentialId} is not a GitHub credential or does not exist.`
      : 'Manual reconcile currently requires at least one GitHub source credential.');
  }
  const merged = new Map<string, DiscoveredSourceRepository>();
  for (const [credentialId, credential] of entries) {
    let discovered: DiscoveredSourceRepository[];
    try {
      discovered = await discoverGithubRepositories({
        credentialId,
        credential,
        apiTimeoutMs: input.config.runtime.apiTimeoutMs,
        apiDelayMs: input.apiDelayMs,
        orgs: input.orgs,
      });
    } catch (error) {
      input.logger.error({ credentialId, orgs: input.orgs, error: toPublicError(error) }, 'reconcile.source_discovery_failed');
      throw error;
    }
    for (const repository of discovered) merged.set(repository.fullName.toLowerCase(), repository);
  }
  return [...merged.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

async function reconcileRepository(input: {
  config: AppConfig;
  client: RtdbClient;
  logger: Logger;
  dryRun?: boolean;
  destinations?: string[];
  adapters?: Record<string, ProviderAdapter>;
  repository: DiscoveredSourceRepository;
  destinationFilter?: Set<string>;
  destinationWorkspaceCache: Map<string, Promise<string>>;
  apiDelayMs?: number;
}): Promise<RepositoryReconcileResult> {
  const repository = input.repository;
  try {
    const repoFilterMatch = isExcludedRepo(repository.repo, input.config.src.filter);
    if (repoFilterMatch.matched) {
      return { sourceRepo: repository.fullName, status: 'filtered' };
    }

    const sourceRemote = await listRemoteRefs(repository.url, repository.credential, input.config.runtime.gitTimeoutMs);
    if (!sourceRemote.ok) {
      return { sourceRepo: repository.fullName, status: 'error', error: sourceRemote.error };
    }
    const ref = `refs/heads/${repository.defaultBranch}`;
    const sha = sourceRemote.refs.get(ref);
    if (!sha) return { sourceRepo: repository.fullName, ref, status: 'empty' };

    let commitMessage = '';
    if ((input.config.src.filter?.commit?.exclude?.length ?? 0) > 0) {
      commitMessage = await getGithubCommitMessage({
        repository,
        sha,
        apiTimeoutMs: input.config.runtime.apiTimeoutMs,
      });
      if (isExcludedCommit([commitMessage], input.config.src.filter).matched) {
        return { sourceRepo: repository.fullName, ref, sha, status: 'filtered' };
      }
    }

    const source: SourceRepository = {
      provider: 'github',
      owner: repository.owner,
      repo: repository.repo,
      fullName: repository.fullName,
      url: repository.url,
      ref,
      sha,
      credential: repository.credential,
    };
    const destinations: DestinationDrift[] = [];
    const drifted: string[] = [];
    let sourceWorkspace: string | undefined;
    const recordDestination = (result: DestinationDrift): void => {
      destinations.push(result);
      const context: Record<string, unknown> = {
        sourceRepo: repository.fullName,
        destinationId: result.destinationId,
        status: result.status,
        reason: result.reason,
        error: result.error,
      };
      if (result.status === 'in-sync' || result.status === 'skipped') {
        input.logger.debug(context, 'reconcile.destination_compared');
      } else {
        input.logger.info(context, 'reconcile.destination_compared');
      }
    };

    for (const [destinationId, destination] of Object.entries(input.config.dest)) {
      if (input.destinationFilter && !input.destinationFilter.has(destinationId)) continue;
      if (destination.enabled === false) {
        recordDestination({ destinationId, status: 'skipped', reason: 'destination-disabled' });
        continue;
      }
      const locator = locatorFor(destination, source);
      if (isSameRepository(destination.type, locator, source)) {
        recordDestination({ destinationId, status: 'skipped', reason: 'self-loop' });
        continue;
      }
      input.logger.debug({ sourceRepo: repository.fullName, destinationId }, 'reconcile.destination_checking');
      try {
        const adapter = input.adapters?.[destinationId] ?? createProviderAdapter(destinationId, destination, input.config.runtime.apiTimeoutMs);
        let cloneUrl = adapter.resolveCloneUrl(locator);
        let destinationRemote = await listRemoteRefs(cloneUrl, destination.creds, input.config.runtime.gitTimeoutMs);
        if (!destinationRemote.ok) {
          const existing = await adapter.getRepository(locator);
          if ((input.apiDelayMs ?? 0) > 0) await delay(input.apiDelayMs);
          if (!existing) {
            recordDestination({ destinationId, status: 'drift', reason: 'destination-missing' });
            drifted.push(destinationId);
            continue;
          }
          cloneUrl = existing.cloneUrl;
          destinationRemote = await listRemoteRefs(cloneUrl, destination.creds, input.config.runtime.gitTimeoutMs);
          if (!destinationRemote.ok) {
            recordDestination({ destinationId, status: 'error', reason: 'destination-unreachable', error: destinationRemote.error });
            continue;
          }
        }

        if (destination.mode === 'one-to-one') {
          const reason = compareOneToOne(sourceRemote.refs, destinationRemote.refs, destination);
          if (reason) {
            recordDestination({ destinationId, status: 'drift', reason });
            drifted.push(destinationId);
          } else recordDestination({ destinationId, status: 'in-sync' });
          continue;
        }

        const directory = resolveDirectory(destination, source);
        const workspaceKey = `${destinationId}:${cloneUrl}:${destination.branch}:${directory}`;
        let destinationWorkspacePromise = input.destinationWorkspaceCache.get(workspaceKey);
        if (!destinationWorkspacePromise) {
          destinationWorkspacePromise = ensureDestinationWorkspace(
            cloneUrl,
            destination.branch,
            destination.creds,
            resolve(input.config.runtime.workdir, 'reconcile'),
            input.config.runtime.gitTimeoutMs,
            [directory],
          );
          input.destinationWorkspaceCache.set(workspaceKey, destinationWorkspacePromise);
        }
        const destinationWorkspace = await destinationWorkspacePromise;
        if (!(await directoryExistsInHead(destinationWorkspace, directory, input.config.runtime.gitTimeoutMs))) {
          recordDestination({ destinationId, status: 'drift', reason: `directory-missing:${directory}` });
          drifted.push(destinationId);
          continue;
        }
        const marker = sourceCommitMarker(destination.commit, source, directory);
        if (marker) {
          const messages = await adapter.listBranchCommitMessages({
            locator,
            branch: destination.branch,
            path: directory,
            maxCount: RECONCILE_COMMIT_SCAN_LIMIT,
            apiDelayMs: input.apiDelayMs,
            searchFor: marker,
          });
          if (messages.some((message) => message.includes(marker))) {
            recordDestination({ destinationId, status: 'in-sync' });
          } else {
            recordDestination({ destinationId, status: 'drift', reason: 'source-commit-not-synced' });
            drifted.push(destinationId);
          }
          continue;
        }

        sourceWorkspace ??= await ensureSourceWorkspace(
          source,
          resolve(input.config.runtime.workdir, 'reconcile'),
          input.config.runtime.gitTimeoutMs,
        );
        const matches = await directoryTreeMatchesCommit(
          destinationWorkspace,
          sourceWorkspace,
          sha,
          directory,
          input.config.runtime.gitTimeoutMs,
        );
        if (!matches) {
          recordDestination({ destinationId, status: 'drift', reason: 'directory-tree-mismatch' });
          drifted.push(destinationId);
        } else recordDestination({ destinationId, status: 'in-sync' });
      } catch (error) {
        recordDestination({ destinationId, status: 'error', error: toPublicError(error) });
      }
    }

    if (drifted.length === 0) {
      if (destinations.some((destination) => destination.status === 'error')) {
        return { sourceRepo: repository.fullName, ref, sha, status: 'error', destinations };
      }
      return { sourceRepo: repository.fullName, ref, sha, status: 'in-sync', destinations };
    }

    const eventId = `manual-${stableHash(`${repository.fullName}:${ref}:${sha}:${[...drifted].sort().join(',')}`)}`;
    const event: HookEvent = {
      eventId,
      provider: 'github',
      sourceCredentialId: repository.credentialId,
      repo: repository.fullName,
      url: repository.url,
      ref,
      after: sha,
      receivedAt: Date.now(),
      targetDestinations: drifted,
      raw: {
        manualReconcile: true,
        head_commit: { id: sha, message: commitMessage },
        commits: commitMessage ? [{ id: sha, message: commitMessage }] : [],
      },
    };
    if (input.dryRun) {
      return { sourceRepo: repository.fullName, ref, sha, status: 'would-queue', eventId, targetDestinations: drifted, destinations };
    }
    const queued = await input.client.transaction<HookEvent>(`${input.config.rtdb.pendingPath}/${eventId}`, (current) => current ?? event);
    input.logger.info({ eventId, sourceRepo: repository.fullName, targetDestinations: drifted, queued: queued.committed }, 'reconcile.event_queued');
    return {
      sourceRepo: repository.fullName,
      ref,
      sha,
      status: 'queued',
      queueStatus: queued.committed ? 'queued' : 'already-pending',
      eventId,
      targetDestinations: drifted,
      destinations,
    };
  } catch (error) {
    return { sourceRepo: repository.fullName, status: 'error', error: toPublicError(error) };
  }
}

async function directoryExistsInHead(workspace: string, directory: string, timeoutMs: number): Promise<boolean> {
  const result = await runGit(['ls-tree', '-d', '--name-only', 'HEAD', directory], {
    cwd: workspace,
    timeoutMs,
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.trim() === directory;
}

function locatorFor(destination: DestinationConfig, source: SourceRepository): RepoLocator {
  return {
    org: render(destination.org, source),
    repo: render(destination.repo, source),
    ...(destination.project ? { project: render(destination.project, source) } : {}),
  };
}

function sourceCommitMarker(commit: CommitConfig, source: SourceRepository, directory: string): string | undefined {
  const entry = Object.entries(commit.trailers).find(([, template]) => template.includes('{{sourceSha}}'));
  if (!entry) return undefined;
  const [key, template] = entry;
  const values: Record<string, string> = {
    prefix: commit.messagePrefix,
    sourceOwner: source.owner,
    sourceRepo: source.repo,
    sourceRef: source.ref,
    sourceBranch: source.ref.replace(/^refs\/heads\//, ''),
    sourceSha: source.sha,
    sourceShortSha: source.sha.slice(0, 12),
    sourceDirectory: directory,
  };
  return `${key}: ${renderCommitTemplate(template, values)}`;
}

function renderCommitTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
}

function compareOneToOne(
  sourceRefs: Map<string, string>,
  destinationRefs: Map<string, string>,
  destination: DestinationConfig,
): string | undefined {
  const expected = refsForPushPolicy(sourceRefs, destination.push);
  const actual = refsForPushPolicy(destinationRefs, destination.push);
  for (const [ref, sha] of expected) {
    if (actual.get(ref) !== sha) return `ref-mismatch:${ref}`;
  }
  if (destination.push.deleteMissingRefs) {
    for (const ref of actual.keys()) {
      if (!expected.has(ref)) return `extra-ref:${ref}`;
    }
  }
  return undefined;
}
