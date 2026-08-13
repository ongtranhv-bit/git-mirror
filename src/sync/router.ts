import { resolve } from 'node:path';
import { AppError, toPublicError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { sanitizeRtdbKey, validateDestinationDirectory } from '../shared/paths.js';
import { withRetry } from '../shared/retry.js';
import { ensureSourceWorkspace, validateSourceUrl } from '../git/workspace.js';
import { createProviderAdapter } from '../providers/factory.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { RtdbClient } from '../rtdb/client.js';
import { acquireDestinationLock, refreshLock, releaseDestinationLock } from '../rtdb/locks.js';
import { saveRepositoryState, saveSyncState } from '../rtdb/state.js';
import { commitMessagesOf, isExcludedCommit, isExcludedRepo } from '../filter.js';
import type {
  AppConfig,
  DestinationConfig,
  DestinationResult,
  HookEvent,
  RemoteRepository,
  RepoLocator,
  SourceRepository,
  SyncEventResult,
} from '../types.js';
import { syncManyToOne } from './many-to-one.js';
import { syncOneToOne } from './one-to-one.js';

export class SyncAggregateError extends AppError {
  readonly result: SyncEventResult;

  constructor(result: SyncEventResult) {
    super('SYNC_DESTINATIONS_FAILED', 'One or more destinations failed.', {
      context: { failedDestinations: result.destinations.filter((item) => item.status === 'failed').map((item) => item.destinationId) },
    });
    this.result = result;
  }
}

export function resolveSourceFromHook(config: AppConfig, hook: HookEvent): SourceRepository {
  if (!hook.eventId || !hook.provider || !hook.repo || !hook.url || !hook.ref || !hook.after) {
    throw new AppError('HOOK_INVALID', 'Hook event requires eventId, provider, repo, url, ref, and after.');
  }
  validateSourceUrl(hook.url);
  if (!/^refs\/(heads|tags)\//.test(hook.ref)) throw new AppError('HOOK_REF_INVALID', `Unsupported hook ref: ${hook.ref}`);
  if (!/^[0-9a-f]{7,64}$/i.test(hook.after) || /^0+$/.test(hook.after)) {
    throw new AppError('HOOK_SHA_INVALID', `Hook after value is not a usable commit SHA: ${hook.after}`);
  }
  const [owner, repo, ...rest] = hook.repo.split('/');
  if (!owner || !repo || rest.length > 0) throw new AppError('HOOK_REPO_INVALID', `Hook repo must be owner/name: ${hook.repo}`);
  const explicitCredential = hook.sourceCredentialId ? config.src.creds[hook.sourceCredentialId] : undefined;
  if (hook.sourceCredentialId && !explicitCredential) {
    throw new AppError('SOURCE_CREDENTIAL_MISSING', `Source credential ${hook.sourceCredentialId} does not exist.`);
  }
  if (explicitCredential && explicitCredential.type !== hook.provider) {
    throw new AppError(
      'SOURCE_CREDENTIAL_MISMATCH',
      `Source credential ${hook.sourceCredentialId} is ${explicitCredential.type}, but hook provider is ${hook.provider}.`,
    );
  }
  const credential = explicitCredential
    ?? config.src.creds[hook.provider]
    ?? Object.values(config.src.creds).find((item) => item.type === hook.provider);
  if (!credential) throw new AppError('SOURCE_CREDENTIAL_MISSING', `No source credential configured for ${hook.provider}.`);
  return {
    provider: hook.provider,
    owner,
    repo,
    fullName: hook.repo,
    url: hook.url,
    ref: hook.ref,
    sha: hook.after,
    credential,
  };
}

export async function processHookEvent(input: {
  config: AppConfig;
  hook: HookEvent;
  instanceId: string;
  logger: Logger;
  rtdb?: RtdbClient;
  dryRun?: boolean;
  adapters?: Record<string, ProviderAdapter>;
}): Promise<SyncEventResult> {
  const startedAt = Date.now();
  const source = resolveSourceFromHook(input.config, input.hook);
  const destinationEntries = resolveDestinationEntries(input.config, input.hook.targetDestinations);
  const repoFilterMatch = isExcludedRepo(source.repo, input.config.src.filter);
  if (repoFilterMatch.matched) {
    return skippedByFilterResult({
      hook: input.hook,
      source,
      startedAt,
      instanceId: input.instanceId,
      destinations: destinationEntries,
      code: 'REPO_FILTERED',
      message: `Repository excluded by filter (${repoFilterMatch.rule?.mode}: ${repoFilterMatch.rule?.value}); skipping sync.`,
    });
  }
  const filterMatch = isExcludedCommit(commitMessagesOf(input.hook.raw), input.config.src.filter);
  if (filterMatch.matched) {
    return skippedByFilterResult({
      hook: input.hook,
      source,
      startedAt,
      instanceId: input.instanceId,
      destinations: destinationEntries,
      code: 'COMMIT_FILTERED',
      message: `Commit message excluded by filter (${filterMatch.rule?.mode}: ${filterMatch.rule?.value}); skipping sync.`,
    });
  }
  const workdir = resolve(input.config.runtime.workdir, 'instances', input.instanceId);
  const sourceWorkspace = await ensureSourceWorkspace(source, workdir, input.config.runtime.gitTimeoutMs);
  const destinations: DestinationResult[] = [];

  for (const [destinationId, destination] of destinationEntries) {
    const destinationStarted = Date.now();
    if (destination.enabled === false) {
      destinations.push({
        destinationId,
        provider: destination.type,
        mode: destination.mode,
        repo: render(destination.repo, source),
        sourceSha: source.sha,
        status: 'skipped',
        durationMs: Date.now() - destinationStarted,
        error: { code: 'DESTINATION_DISABLED', message: 'Destination is disabled in config.', retryable: false },
      });
      continue;
    }
    const locator: RepoLocator = {
      org: render(destination.org, source),
      repo: render(destination.repo, source),
      ...(destination.project ? { project: render(destination.project, source) } : {}),
    };
    if (isSameRepository(destination.type, locator, source)) {
      destinations.push({
        destinationId,
        provider: destination.type,
        mode: destination.mode,
        repo: locator.repo,
        directory: destination.mode === 'many-to-one' ? resolveDirectory(destination, source) : undefined,
        sourceSha: source.sha,
        status: 'skipped',
        durationMs: Date.now() - destinationStarted,
        error: { code: 'SELF_LOOP_PREVENTED', message: 'Destination matches the source repository; skipping to avoid an infinite mirror loop.', retryable: false },
      });
      continue;
    }
    try {
      const result = await withRetry(
        () =>
          processDestination({
            ...input,
            destinationId,
            destination,
            source,
            sourceWorkspace,
            workdir,
          }),
        {
          retries: input.config.runtime.maxRetries,
          backoffMs: input.config.runtime.retryBackoffMs,
          onRetry: (error, attempt) =>
            input.logger.warn({ destinationId, attempt, error: toPublicError(error) }, 'destination.retry'),
        },
      );
      destinations.push(result);
      if (input.rtdb && result.status !== 'failed') {
        await saveSyncState(input.rtdb, input.config.rtdb.statePath, destinationId, result, input.hook.eventId);
      }
    } catch (error) {
      destinations.push({
        destinationId,
        provider: destination.type,
        mode: destination.mode,
        repo: render(destination.repo, source),
        directory: destination.mode === 'many-to-one' ? resolveDirectory(destination, source) : undefined,
        sourceSha: source.sha,
        status: 'failed',
        durationMs: Date.now() - destinationStarted,
        error: toPublicError(error),
      });
    }
  }

  const result: SyncEventResult = {
    eventId: input.hook.eventId,
    sourceRepo: source.fullName,
    sourceSha: source.sha,
    startedAt,
    completedAt: Date.now(),
    instanceId: input.instanceId,
    destinations,
  };
  if (destinations.some((destination) => destination.status === 'failed')) throw new SyncAggregateError(result);
  return result;
}

function resolveDestinationEntries(
  config: AppConfig,
  targets: string[] | undefined,
): Array<[string, DestinationConfig]> {
  if (!targets) return Object.entries(config.dest);
  const unique = [...new Set(targets.map((item) => item.trim()).filter(Boolean))];
  if (unique.length === 0) throw new AppError('HOOK_TARGET_INVALID', 'targetDestinations must contain at least one destination id.');
  const entries: Array<[string, DestinationConfig]> = [];
  for (const id of unique) {
    const destination = config.dest[id];
    if (!destination) throw new AppError('HOOK_TARGET_INVALID', `Unknown target destination: ${id}.`);
    entries.push([id, destination]);
  }
  return entries;
}

function skippedByFilterResult(input: {
  hook: HookEvent;
  source: SourceRepository;
  startedAt: number;
  instanceId: string;
  destinations: Array<[string, DestinationConfig]>;
  code: string;
  message: string;
}): SyncEventResult {
  return {
    eventId: input.hook.eventId,
    sourceRepo: input.source.fullName,
    sourceSha: input.source.sha,
    startedAt: input.startedAt,
    completedAt: Date.now(),
    instanceId: input.instanceId,
    destinations: input.destinations.map(([destinationId, destination]) => ({
      destinationId,
      provider: destination.type,
      mode: destination.mode,
      repo: render(destination.repo, input.source),
      directory: destination.mode === 'many-to-one' ? resolveDirectory(destination, input.source) : undefined,
      sourceSha: input.source.sha,
      status: 'skipped',
      durationMs: 0,
      error: { code: input.code, message: input.message, retryable: false },
    })),
  };
}

async function processDestination(input: {
  config: AppConfig;
  hook: HookEvent;
  instanceId: string;
  logger: Logger;
  rtdb?: RtdbClient;
  dryRun?: boolean;
  adapters?: Record<string, ProviderAdapter>;
  destinationId: string;
  destination: DestinationConfig;
  source: SourceRepository;
  sourceWorkspace: string;
  workdir: string;
}): Promise<DestinationResult> {
  const adapter = input.adapters?.[input.destinationId] ?? createProviderAdapter(input.destinationId, input.destination, input.config.runtime.apiTimeoutMs);
  const locator: RepoLocator = {
    org: render(input.destination.org, input.source),
    repo: render(input.destination.repo, input.source),
    ...(input.destination.project ? { project: render(input.destination.project, input.source) } : {}),
  };
  const lockKey = `${input.destination.type}/${locator.org}/${locator.project ?? '-'}/${locator.repo}`;
  let locked = false;
  let lockHeartbeat: NodeJS.Timeout | undefined;
  if (input.rtdb) {
    locked = await acquireDestinationLock(
      input.rtdb,
      input.config.rtdb.locksPath,
      lockKey,
      input.instanceId,
      input.config.runtime.lockTtlSeconds,
      { instancesPath: input.config.rtdb.instancesPath },
    );
    if (!locked) throw new AppError('DESTINATION_LOCKED', `Destination is locked: ${lockKey}`, { retryable: true });
    const lockPath = `${input.config.rtdb.locksPath}/${sanitizeRtdbKey(lockKey)}`;
    lockHeartbeat = setInterval(
      () => void refreshLock(input.rtdb!, lockPath, input.instanceId, input.config.runtime.lockTtlSeconds)
        .catch((error) => input.logger.warn({ destinationId: input.destinationId, error: toPublicError(error) }, 'destination.lock_heartbeat_failed')),
      Math.max(1_000, Math.floor((input.config.runtime.lockTtlSeconds * 1_000) / 3)),
    );
    lockHeartbeat.unref();
  }
  try {
    const repository = await ensureDestinationRepository(adapter, locator, input.destination, Boolean(input.dryRun));
    if (input.rtdb) await saveRepositoryState(input.rtdb, input.config.rtdb.statePath, input.destinationId, repository);
    if (input.destination.mode === 'one-to-one') {
      return await syncOneToOne({
        destinationId: input.destinationId,
        destination: input.destination,
        repository,
        source: input.source,
        sourceWorkspace: input.sourceWorkspace,
        timeoutMs: input.config.runtime.gitTimeoutMs,
        dryRun: Boolean(input.dryRun),
      });
    }
    return await syncManyToOne({
      destinationId: input.destinationId,
      destination: input.destination,
      repository,
      source: input.source,
      sourceWorkspace: input.sourceWorkspace,
      directory: resolveDirectory(input.destination, input.source),
      workdir: input.workdir,
      instanceId: input.instanceId,
      timeoutMs: input.config.runtime.gitTimeoutMs,
      dryRun: Boolean(input.dryRun),
    });
  } finally {
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    if (input.rtdb && locked) {
      try {
        await releaseDestinationLock(input.rtdb, input.config.rtdb.locksPath, lockKey, input.instanceId);
      } catch (error) {
        input.logger.warn({ destinationId: input.destinationId, error: toPublicError(error) }, 'destination.lock_release_failed');
      }
    }
  }
}

export async function ensureDestinationRepository(
  adapter: ProviderAdapter,
  locator: RepoLocator,
  destination: DestinationConfig,
  dryRun: boolean,
): Promise<RemoteRepository> {
  const existing = await adapter.getRepository(locator);
  if (existing) return existing;
  if (dryRun) {
    return {
      provider: destination.type,
      org: locator.org,
      repo: locator.repo,
      project: locator.project,
      cloneUrl: adapter.resolveCloneUrl(locator),
      created: false,
    };
  }
  if (!destination.autoCreate.enabled) {
    throw new AppError('DESTINATION_NOT_FOUND', `Destination repository ${locator.org}/${locator.repo} does not exist and autoCreate is disabled.`);
  }
  return adapter.createRepository({
    ...locator,
    private: destination.autoCreate.private ?? true,
    description: destination.autoCreate.description,
  });
}

export function resolveDirectory(destination: Extract<DestinationConfig, { mode: 'many-to-one' }>, source: SourceRepository): string {
  const mapped = destination.directoryMap[source.fullName] ?? destination.directoryMap[source.repo];
  return validateDestinationDirectory(render(mapped ?? destination.directory, source));
}

export function isSameRepository(provider: string, locator: RepoLocator, source: SourceRepository): boolean {
  return provider === source.provider && locator.org === source.owner && locator.repo === source.repo;
}

export function render(template: string, source: SourceRepository): string {
  return template.replaceAll('{sourceRepo}', source.repo).replaceAll('{sourceOwner}', source.owner);
}
