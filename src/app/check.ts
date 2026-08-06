import { createProviderAdapter } from '../providers/factory.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { toPublicError } from '../shared/errors.js';
import type { AppConfig, HookEvent, RepoLocator, SourceRepository } from '../types.js';
import { render, resolveSourceFromHook } from '../sync/router.js';

export interface RepositoryCheckResult {
  destinationId: string;
  status: 'exists' | 'missing' | 'skipped' | 'error';
  locator?: RepoLocator;
  cloneUrl?: string;
  error?: ReturnType<typeof toPublicError>;
}

export async function checkRepositories(input: {
  config: AppConfig;
  hook?: HookEvent;
  adapters?: Record<string, ProviderAdapter>;
}): Promise<RepositoryCheckResult[]> {
  const source = input.hook ? resolveSourceFromHook(input.config, input.hook) : undefined;
  const results: RepositoryCheckResult[] = [];
  for (const [destinationId, destination] of Object.entries(input.config.dest)) {
    if (hasPlaceholder(destination.repo) && !source) {
      results.push({ destinationId, status: 'skipped' });
      continue;
    }
    const adapter = input.adapters?.[destinationId] ?? createProviderAdapter(destinationId, destination, input.config.runtime.apiTimeoutMs);
    try {
      await adapter.validateCredential();
      const locator = locatorFor(destination, source);
      const repository = await adapter.getRepository(locator);
      results.push({
        destinationId,
        status: repository ? 'exists' : 'missing',
        locator,
        cloneUrl: repository?.cloneUrl ?? adapter.resolveCloneUrl(locator),
      });
    } catch (error) {
      results.push({ destinationId, status: 'error', error: toPublicError(error) });
    }
  }
  return results;
}

export function locatorFor(
  destination: AppConfig['dest'][string],
  source?: SourceRepository,
): RepoLocator {
  const resolveValue = (value: string): string => {
    if (!hasPlaceholder(value)) return value;
    if (!source) throw new Error(`Value requires hook context: ${value}`);
    return render(value, source);
  };
  return {
    org: resolveValue(destination.org),
    repo: resolveValue(destination.repo),
    ...(destination.project ? { project: resolveValue(destination.project) } : {}),
  };
}

function hasPlaceholder(value: string): boolean {
  return value.includes('{sourceRepo}') || value.includes('{sourceOwner}');
}
