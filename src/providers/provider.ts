import type { DestinationConfig, RemoteRepository, RepoLocator } from '../types.js';

export interface CreateRepoInput extends RepoLocator {
  private: boolean;
  description?: string;
}

export interface ProviderAdapter {
  readonly destinationId: string;
  readonly config: DestinationConfig;
  validateCredential(): Promise<void>;
  getRepository(input: RepoLocator): Promise<RemoteRepository | null>;
  createRepository(input: CreateRepoInput): Promise<RemoteRepository>;
  resolveCloneUrl(input: RepoLocator): string;
}
