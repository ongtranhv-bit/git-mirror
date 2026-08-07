import type { Logger } from '../shared/logger.js';
import { toPublicError } from '../shared/errors.js';
import { stableHash } from '../shared/paths.js';
import type { RtdbClient } from '../rtdb/client.js';
import { commitMessagesOf, isExcludedCommit, isExcludedRepo } from '../filter.js';
import type { AppConfig, HookEvent, ProviderType } from '../types.js';

interface GithubWebhookDelivery {
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
    if (typeof payload === 'object' && payload !== null && (payload as { _bridge?: unknown })._bridge) {
      await options.client.remove(`${options.webhookPath ?? '/github-noti'}/${childKey}`);
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
  const unsubscribe = options.client.onChildAdded<GithubWebhookDelivery>(
    options.webhookPath ?? '/github-noti',
    (childKey, payload) => {
      const result = { processed: 0, skipped: 0 };
      return processDelivery(options, childKey, payload, result);
    },
  );
  return { stop: () => unsubscribe(), idle: async () => undefined };
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
    const repoFilterMatch = isExcludedRepo(event.repo, options.config.src.filter);
    if (repoFilterMatch.matched) {
      const claimed = await claimDelivery(options, childPath);
      if (claimed) {
        result.skipped += 1;
        log.info(
          { mode: repoFilterMatch.rule?.mode, value: repoFilterMatch.rule?.value, repo: event.repo },
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
    });
    await options.client.remove(childPath);
    result.processed += 1;
    log.info({ eventId: event.eventId, repo: event.repo, ref: event.ref, after: event.after }, 'webhook.event_queued');
  } catch (error) {
    log.error({ error: toPublicError(error) }, 'webhook.process_error');
  }
}

async function claimDelivery(options: GithubBridgeOptions, childPath: string, eventId?: string): Promise<boolean> {
  const committed = await options.client.transaction<GithubWebhookDelivery>(
    childPath,
    (current) => {
      if (!current || typeof current !== 'object' || (current as { _bridge?: unknown })._bridge) return undefined;
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
  };
  return hookEvent;
}
