export type RotationStatus =
  | 'planned'
  | 'claimed'
  | 'preflight_ok'
  | 'create_requested'
  | 'codespace_available'
  | 'runtime_ready'
  | 'promoted'
  | 'old_stop_requested'
  | 'completed'
  | 'failed'
  | 'cleanup_pending'
  | 'rollback_pending'
  | 'rolled_back';

export interface CodespaceAccountConfig {
  expectedLogin: string;
  tokenEnv: string;
}

export interface RotationDayConfig {
  enabled: boolean;
  codespaceAccount: CodespaceAccountConfig;
}

export interface BootstrapConfig {
  owner: string;
  repo: string;
  branch: string;
  machine?: string;
  devcontainerPath?: string;
  idleTimeoutMinutes?: number;
  retentionPeriodDays?: number;
}

export interface RotationRuntimeConfig {
  rotationLockTtlSeconds: number;
  healthPollSeconds: number;
  healthTimeoutSeconds: number;
  maxRetries: number;
  retryBackoffMs: number;
  stabilizationSeconds: number;
  stopOldAfterHealthy: boolean;
  deleteOldAfterStop: boolean;
}

export interface RotationTestingConfig {
  enabled: boolean;
  useRealCodespace: boolean;
  tokenDay?: number;
  stopOldAfterHealthy: boolean;
}

export interface RotationConfig {
  configVersion: number;
  enabled: boolean;
  timezone: string;
  startAt: string;
  days: Record<string, RotationDayConfig>;
  bootstrap: BootstrapConfig;
  runtime: RotationRuntimeConfig;
  testing: RotationTestingConfig;
}

export interface CodespaceInfo {
  name: string;
  id?: number;
  state: string;
  repository: string;
  branch?: string;
  machine?: string;
  ownerLogin?: string;
  createdAt?: string;
  updatedAt?: string;
  displayName?: string;
}

export interface CreateCodespaceInput {
  owner: string;
  repo: string;
  branch: string;
  machine?: string;
  devcontainerPath?: string;
  displayName?: string;
  idleTimeoutMinutes?: number;
  retentionPeriodMinutes?: number;
}

export interface CodespaceMachine {
  name: string;
  displayName?: string;
  cpus?: number;
  memoryInBytes?: number;
  storageInBytes?: number;
}

export interface CodespaceLifecycle {
  getAuthenticatedUser(): Promise<{ login: string }>;
  resolveRepositoryHead(owner: string, repo: string, branch: string): Promise<string>;
  listMachines(owner: string, repo: string): Promise<CodespaceMachine[]>;
  list(): Promise<CodespaceInfo[]>;
  create(input: CreateCodespaceInput): Promise<CodespaceInfo>;
  get(name: string): Promise<CodespaceInfo>;
  start(name: string): Promise<CodespaceInfo>;
  stop(name: string): Promise<CodespaceInfo>;
  delete(name: string): Promise<void>;
}

export interface ActiveCodespacePointer {
  codespaceName: string;
  ownerLogin: string;
  credentialProfile: string;
  commitSha: string;
  instanceId?: string;
  promotedAt: number;
}

export interface RotationEndpoint {
  codespaceName: string;
  ownerLogin: string;
  credentialProfile: string;
  commitSha: string;
  instanceId?: string;
}

export interface RotationChecks {
  tokenIdentity?: boolean;
  repositoryHead?: boolean;
  machineAvailable?: boolean;
  codespaceAvailable?: boolean;
  runtimeReady?: boolean;
  runtimeCommitMatches?: boolean;
  heartbeatFresh?: boolean;
}

export interface RotationRecord {
  rotationKey: string;
  dayOfMonth: number;
  status: RotationStatus;
  configHash: string;
  bootstrapRepository: string;
  expectedCommitSha?: string;
  runtimeCommitSha?: string;
  previous?: RotationEndpoint;
  next?: RotationEndpoint;
  checks: RotationChecks;
  startedAt: number;
  updatedAt: number;
  promotedAt?: number;
  completedAt?: number;
  oldStoppedAt?: number;
  error?: { code: string; message: string; retryable: boolean };
  cleanup?: { required: boolean; stopped?: boolean; deleteRequested?: boolean; deleted?: boolean };
}

export interface RuntimeReadinessRecord {
  instanceId: string;
  codespaceName: string;
  status: 'starting' | 'ready' | 'stopped';
  repository?: string;
  branch?: string;
  runtimeCommitSha?: string;
  serviceVersion?: string;
  rtdbConnected: boolean;
  listenerAttached: boolean;
  startedAt: number;
  readyAt?: number;
  heartbeatAt: number;
  currentEvent?: string | null;
}
