import type { ProviderAdapter } from '../providers/provider.js';
import type { RtdbClient } from '../rtdb/client.js';
import { saveRepositoryState } from '../rtdb/state.js';
import { toPublicError } from '../shared/errors.js';
import { ensureDestinationRepository, resolveSourceFromHook } from '../sync/router.js';
import type { AppConfig, HookEvent, RemoteRepository } from '../types.js';
import { locatorFor } from './check.js';
import { createProviderAdapter } from '../providers/factory.js';

export interface RepositoryInitResult {
  destinationId: string;
  status: 'created' | 'exists' | 'dry-run' | 'skipped' | 'error';
  repository?: RemoteRepository;
  error?: ReturnType<typeof toPublicError>;
}

export async function initRepositories(input: {
  config: AppConfig;
  hook?: HookEvent;
  dryRun?: boolean;
  rtdb?: RtdbClient;
  adapters?: Record<string, ProviderAdapter>;
}): Promise<RepositoryInitResult[]> {
  const source = input.hook ? resolveSourceFromHook(input.config, input.hook) : undefined;
  const results: RepositoryInitResult[] = [];
  for (const [destinationId, destination] of Object.entries(input.config.dest)) {
    if ((destination.repo.includes('{sourceRepo}') || destination.repo.includes('{sourceOwner}')) && !source) {
      results.push({ destinationId, status: 'skipped' });
      continue;
    }
    const adapter = input.adapters?.[destinationId] ?? createProviderAdapter(destinationId, destination, input.config.runtime.apiTimeoutMs);
    try {
      const locator = locatorFor(destination, source);
      const existing = await adapter.getRepository(locator);
      if (existing) {
        if (input.rtdb) await saveRepositoryState(input.rtdb, input.config.rtdb.statePath, destinationId, existing);
        results.push({ destinationId, status: 'exists', repository: existing });
        continue;
      }
      const repository = await ensureDestinationRepository(adapter, locator, destination, Boolean(input.dryRun));
      if (input.rtdb) await saveRepositoryState(input.rtdb, input.config.rtdb.statePath, destinationId, repository);
      results.push({
        destinationId,
        status: input.dryRun ? 'dry-run' : repository.created ? 'created' : 'exists',
        repository,
      });
    } catch (error) {
      results.push({ destinationId, status: 'error', error: toPublicError(error) });
    }
  }
  return results;
}
