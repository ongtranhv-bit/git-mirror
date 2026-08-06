export type ProviderType = 'github' | 'gitea' | 'azure' | 'custom';
export type SyncMode = 'one-to-one' | 'many-to-one';

export interface CredentialConfig {
  type: ProviderType;
  token: string;
  scheme?: 'bearer' | 'basic' | 'token' | 'custom';
  username?: string;
  headerName?: string;
  headerValueTemplate?: string;
}

export interface AutoCreateConfig {
  enabled: boolean;
  private?: boolean;
  description?: string;
}

export interface PushPolicy {
  force: boolean;
  pushTags: boolean;
  deleteMissingRefs: boolean;
  include: string[];
  exclude: string[];
}

export interface CommitConfig {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  messagePrefix: string;
  template: string;
  trailers: Record<string, string>;
}

export interface DestinationBase {
  type: ProviderType;
  mode: SyncMode;
  creds: CredentialConfig;
  org: string;
  repo: string;
  baseUrl?: string;
  project?: string;
  autoCreate: AutoCreateConfig;
  branch: string;
  push: PushPolicy;
  commit: CommitConfig;
}

export interface OneToOneDestination extends DestinationBase {
  mode: 'one-to-one';
}

export interface ManyToOneDestination extends DestinationBase {
  mode: 'many-to-one';
  directory: string;
  directoryMap: Record<string, string>;
}

export type DestinationConfig = OneToOneDestination | ManyToOneDestination;

export interface RuntimeConfig {
  workdir: string;
  lockTtlSeconds: number;
  heartbeatSeconds: number;
  maxRetries: number;
  retryBackoffMs: number;
  gitTimeoutMs: number;
  apiTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface RtdbPaths {
  configPath: string;
  pendingPath: string;
  processingPath: string;
  processedPath: string;
  failedPath: string;
  statePath: string;
  locksPath: string;
  instancesPath: string;
  retentionDays: number;
}

export interface AppConfig {
  configVersion: number;
  src: { creds: Record<string, CredentialConfig> };
  dest: Record<string, DestinationConfig>;
  runtime: RuntimeConfig;
  rtdb: RtdbPaths;
}

export interface HookEvent {
  eventId: string;
  provider: ProviderType;
  repo: string;
  url: string;
  ref: string;
  after: string;
  before?: string;
  receivedAt: number;
  raw?: unknown;
}

export interface SourceRepository {
  provider: ProviderType;
  owner: string;
  repo: string;
  fullName: string;
  url: string;
  ref: string;
  sha: string;
  credential: CredentialConfig;
}

export interface RepoLocator {
  org: string;
  repo: string;
  project?: string;
}

export interface RemoteRepository {
  id?: string;
  provider: ProviderType;
  org: string;
  repo: string;
  project?: string;
  cloneUrl: string;
  webUrl?: string;
  created?: boolean;
}

export interface DestinationResult {
  destinationId: string;
  provider: ProviderType;
  mode: SyncMode;
  repo: string;
  directory?: string;
  sourceSha: string;
  destinationSha?: string;
  status: 'synced' | 'skipped' | 'dry-run' | 'failed';
  durationMs: number;
  error?: PublicError;
}

export interface SyncEventResult {
  eventId: string;
  sourceRepo: string;
  sourceSha: string;
  startedAt: number;
  completedAt: number;
  instanceId: string;
  destinations: DestinationResult[];
}

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  context?: Record<string, unknown>;
}
