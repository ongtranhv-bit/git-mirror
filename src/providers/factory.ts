import type { DestinationConfig } from '../types.js';
import { AppError } from '../shared/errors.js';
import { AzureProvider } from './azure.js';
import { GiteaProvider } from './gitea.js';
import { GitHubProvider } from './github.js';
import type { ProviderAdapter } from './provider.js';

export function createProviderAdapter(destinationId: string, config: DestinationConfig, timeoutMs = 30_000): ProviderAdapter {
  if (config.type === 'github') return new GitHubProvider(destinationId, config, timeoutMs);
  if (config.type === 'gitea') return new GiteaProvider(destinationId, config, timeoutMs);
  if (config.type === 'azure') return new AzureProvider(destinationId, config, timeoutMs);
  throw new AppError('PROVIDER_UNSUPPORTED', `No API adapter is available for custom provider ${destinationId}.`);
}
