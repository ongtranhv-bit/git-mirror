import type { Logger } from '../shared/logger.js';
import { toPublicError } from '../shared/errors.js';
import { stableHash } from '../shared/paths.js';
import type { RtdbClient } from '../rtdb/client.js';
import { commitKeyOf } from '../rtdb/events.js';
import { commitMessagesOf, isExcludedCommit, isExcludedRepo } from '../filter.js';
import type { AppConfig, HookEvent, ProviderType } from '../types.js';

interface GithubWebhookDelivery {
  _bridge?: { consumedAt: number; eventId?: string; skipped?: boolean };
  ref?: string;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  base_ref?: string | null;
  compare?: string;
  commits?: Array<{ id: string }>;
  head_commit?: { id: string } | null;
  repository?: {
    name?: string;
    full_name?: string;
    clone_url?: string;
    html_url?: string;
    pushed_at?: string;
  };
  hook_id?: number;
  zen?: string;
}

export interface GithubBridgeOptions {
  client: RtdbClient;
  config: AppConfig;
  logger: Logger;
  webhookPath?: string;
}

export interface BridgeRunResult {
  processed: number;
  skipped: number;
}

export async function bridgeOnce(options: GithubBridgeOptions): Promise<BridgeRunResult> {
  const deliveries =
    (await options.client.get<Record<string, GithubWebhookDelivery>>(options.webhookPath ?? '/github-noti')) ?? {};
  const result: BridgeRunResult = { processed: 0, skipped: 0 };
  for (const [childKey, payload] of Object.entries(deliveries)) {
    if (typeof payload === 'object' && payload !== null && payload._bridge) {
      await recoverClaimedDelivery(options, childKey, payload, result);
      continue;
    }
    await processDelivery(options, childKey, payload, result);
  }
  return result;
}

export function bridgePendingEvents(options: GithubBridgeOptions): {
  stop: () => void;
  idle: () => Promise<void>;
} {
  let accepting = true;
  let chain = Promise.resolve();
  const unsubscribe = options.client.onChildAdded<GithubWebhookDelivery>(
    options.webhookPath ?? '/github-noti',
    (childKey, payload) => {
      if (!accepting) return;
      const result = { processed: 0, skipped: 0 };
      chain = chain
        .then(() => processDelivery(options, childKey, payload, result))
        .catch((error) => options.logger.error({ childKey, error: toPublicError(error) }, 'webhook.queue_error'));
      return chain;
    },
  );
  return {
    stop: () => { accepting = false; unsubscribe(); },
    idle: () => chain,
  };
}

async function processDelivery(
  options: GithubBridgeOptions,
  childKey: string,
  payload: GithubWebhookDelivery,
  result: BridgeRunResult,
): Promise<void> {
  const log = options.logger.child({ childKey });
  const childPath = `${options.webhookPath ?? '/github-noti'}/${childKey}`;
  try {
    const event = toHookEvent(payload);
    if (!event) {
      const claimed = await claimDelivery(options, childPath);
      if (claimed) {
        result.skipped += 1;
        log.info({}, 'webhook.skipped');
        await options.client.remove(childPath);
      }
      return;
    }
    const repoName = payload.repository?.name ?? event.repo.split('/').at(-1) ?? event.repo;
    const repoFilterMatch = isExcludedRepo(repoName, options.config.src.filter);
    if (repoFilterMatch.matched) {
      const claimed = await claimDelivery(options, childPath);
      if (claimed) {
        result.skipped += 1;
        log.info(
          { mode: repoFilterMatch.rule?.mode, value: repoFilterMatch.rule?.value, repo: event.repo, repoName },
          'webhook.filtered_repo',
        );
        await options.client.remove(childPath);
      }
      return;
    }
    const filterMatch = isExcludedCommit(commitMessagesOf(payload), options.config.src.filter);
    if (filterMatch.matched) {
      const claimed = await claimDelivery(options, childPath);
      if (claimed) {
        result.skipped += 1;
        log.info(
          { mode: filterMatch.rule?.mode, value: filterMatch.rule?.value, repo: event.repo, after: event.after },
          'webhook.filtered',
        );
        await options.client.remove(childPath);
      }
      return;
    }
    const claimed = await claimDelivery(options, childPath, event.eventId);
    if (!claimed) return;
    await options.client.update({
      [`${options.config.rtdb.pendingPath}/${event.eventId}`]: event,
      [childPath]: null,
    });
    result.processed += 1;
    log.info({ eventId: event.eventId, repo: event.repo, ref: event.ref, after: event.after }, 'webhook.event_queued');
  } catch (error) {
    log.error({ error: toPublicError(error) }, 'webhook.process_error');
  }
}

async function recoverClaimedDelivery(
  options: GithubBridgeOptions,
  childKey: string,
  payload: GithubWebhookDelivery,
  result: BridgeRunResult,
): Promise<void> {
  const childPath = `${options.webhookPath ?? '/github-noti'}/${childKey}`;
  const eventId = payload._bridge?.eventId;
  if (!eventId) {
    await options.client.remove(childPath);
    return;
  }
  const event = toHookEvent(payload);
  if (!event) {
    await options.client.remove(childPath);
    result.skipped += 1;
    return;
  }
  const [pending, processing, processed, failed] = await Promise.all([
    options.client.get(`${options.config.rtdb.pendingPath}/${eventId}`),
    options.client.get(`${options.config.rtdb.processingPath}/${commitKeyOf(event)}`),
    options.client.get(`${options.config.rtdb.processedPath}/${eventId}`),
    options.client.get(`${options.config.rtdb.failedPath}/${eventId}`),
  ]);
  if (pending !== null || processing !== null || processed !== null || failed !== null) {
    await options.client.remove(childPath);
    return;
  }
  await options.client.update({
    [`${options.config.rtdb.pendingPath}/${eventId}`]: event,
    [childPath]: null,
  });
  result.processed += 1;
  options.logger.warn({ eventId, childKey }, 'webhook.claim_recovered');
}

async function claimDelivery(options: GithubBridgeOptions, childPath: string, eventId?: string): Promise<boolean> {
  const committed = await options.client.transaction<GithubWebhookDelivery>(
    childPath,
    (current) => {
      if (!current || typeof current !== 'object' || current._bridge) return undefined;
      return {
        ...current,
        _bridge: {
          consumedAt: Date.now(),
          ...(eventId ? { eventId } : { skipped: true }),
        },
      };
    },
  );
  return committed.committed;
}

function toHookEvent(payload: GithubWebhookDelivery): HookEvent | null {
  const ref = payload.ref;
  if (!ref || !/^refs\/(heads|tags)\//.test(ref)) return null;
  const after = payload.after;
  if (!after || /^0+$/.test(after)) return null;
  const repository = payload.repository;
  const fullName = repository?.full_name;
  const cloneUrl = repository?.clone_url ?? repository?.html_url;
  if (!fullName || !cloneUrl) return null;
  const receivedAt = repository?.pushed_at ? Date.parse(repository.pushed_at) : Date.now();
  const eventId = `gh-${stableHash(`${fullName}:${ref}:${after}`)}`;
  const hookEvent: HookEvent = {
    eventId,
    provider: 'github' as ProviderType,
    repo: fullName,
    url: cloneUrl,
    ref,
    after,
    before: payload.before && !/^0+$/.test(payload.before) ? payload.before : undefined,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
    raw: payload,
  };
  return hookEvent;
}
