import { ConfigValidationError } from '../shared/errors.js';
import { assertDirectoriesDoNotOverlap, validateDestinationDirectory } from '../shared/paths.js';
import { registerSecret } from '../shared/logger.js';
import type {
  AppConfig,
  CommitConfig,
  FilterRule,
  CredentialConfig,
  DestinationConfig,
  ProviderType,
  PushPolicy,
  RtdbPaths,
  RuntimeConfig,
  SrcFilterConfig,
} from '../types.js';

const PROVIDERS = new Set<ProviderType>(['github', 'gitea', 'azure', 'custom']);
const MODES = new Set(['one-to-one', 'many-to-one']);
const FILTER_MODES = new Set(['prefix', 'suffix', 'contains']);

const DEFAULT_RUNTIME: RuntimeConfig = {
  workdir: './.cache/repos',
  lockTtlSeconds: 900,
  heartbeatSeconds: 30,
  maxRetries: 3,
  retryBackoffMs: 2_000,
  maxEventRetries: 3,
  gitTimeoutMs: 600_000,
  apiTimeoutMs: 30_000,
  logLevel: 'info',
  codespaceKeepalive: {
    enabled: true,
    intervalMinutes: 10,
  },
};

const DEFAULT_RTDB: RtdbPaths = {
  configPath: '/sync/config',
  webhookPath: '/github-noti',
  pendingPath: '/sync/events/pending',
  processingPath: '/sync/events/processing',
  processedPath: '/sync/events/processed',
  failedPath: '/sync/events/failed',
  statePath: '/sync/state',
  locksPath: '/sync/locks',
  instancesPath: '/sync/instances',
  processedByCommitPath: '/sync/processed-commits',
  retentionDays: 14,
};

const DEFAULT_PUSH: PushPolicy = {
  force: true,
  pushTags: true,
  deleteMissingRefs: false,
  include: ['refs/heads/*', 'refs/tags/*'],
  exclude: [],
};

const DEFAULT_COMMIT: CommitConfig = {
  authorName: 'git-mirror-bot',
  authorEmail: 'git-mirror-bot@localhost',
  committerName: 'git-mirror-bot',
  committerEmail: 'git-mirror-bot@localhost',
  messagePrefix: '[sync]',
  template: '{{prefix}} {{sourceRepo}}: {{sourceSubject}}',
  trailers: {
    'Source-Repo': '{{sourceOwner}}/{{sourceRepo}}',
    'Source-Ref': '{{sourceRef}}',
    'Source-Commit': '{{sourceSha}}',
    'Source-Directory': '{{sourceDirectory}}',
    'Synced-At': '{{timestamp}}',
    'Synced-By': '{{instanceId}}',
  },
};

export function parseConfig(input: unknown): AppConfig {
  const issues: string[] = [];
  const root = asObject(input, '$', issues);
  if (!root) throw new ConfigValidationError(issues);

  const srcObject = asObject(root.src, '$.src', issues);
  if (srcObject) {
    for (const key of Object.keys(srcObject)) {
      if (key !== 'creds' && key !== 'filter') {
        issues.push(`$.src.${key}: src only accepts the creds and filter fields; source metadata must come from hook data.`);
      }
    }
  }
  const credsObject = asObject(srcObject?.creds, '$.src.creds', issues);
  const sourceCreds: Record<string, CredentialConfig> = {};
  if (credsObject) {
    for (const [key, value] of Object.entries(credsObject)) {
      const credential = parseCredential(value, `$.src.creds.${key}`, issues);
      if (credential) sourceCreds[key] = credential;
    }
    if (Object.keys(sourceCreds).length === 0) issues.push('$.src.creds: at least one source credential is required.');
  }
  const sourceFilter = parseSrcFilter(srcObject?.filter, issues);

  const destObject = asObject(root.dest, '$.dest', issues);
  const destinations: Record<string, DestinationConfig> = {};
  if (destObject) {
    for (const [id, value] of Object.entries(destObject)) {
      const destination = parseDestination(value, `$.dest.${id}`, issues);
      if (destination) destinations[id] = destination;
    }
    if (Object.keys(destinations).length === 0) issues.push('$.dest: at least one destination is required.');
  }

  const configVersion = integer(root.configVersion, '$.configVersion', issues, 6, 1);
  const runtime = parseRuntime(root.runtime, issues);
  const rtdb = parseRtdb(root.rtdb, issues);
  crossValidateDestinations(destinations, issues);

  if (issues.length > 0) throw new ConfigValidationError(issues);

  for (const credential of Object.values(sourceCreds)) registerSecret(credential.token);
  for (const destination of Object.values(destinations)) registerSecret(destination.creds.token);

  return {
    configVersion,
    src: { creds: sourceCreds, ...(sourceFilter ? { filter: sourceFilter } : {}) },
    dest: destinations,
    runtime,
    rtdb,
  };
}

function parseCredential(value: unknown, path: string, issues: string[]): CredentialConfig | undefined {
  const object = asObject(value, path, issues);
  if (!object) return undefined;
  const type = provider(object.type, `${path}.type`, issues);
  const token = nonEmptyString(object.token, `${path}.token`, issues);
  if (!type || !token) return undefined;
  const credential: CredentialConfig = { type, token };
  const scheme = optionalString(object.scheme, `${path}.scheme`, issues);
  if (scheme && !['bearer', 'basic', 'token', 'custom'].includes(scheme)) {
    issues.push(`${path}.scheme: expected bearer, basic, token, or custom.`);
  } else if (scheme) {
    credential.scheme = scheme as CredentialConfig['scheme'];
  }
  const username = optionalString(object.username, `${path}.username`, issues);
  const headerName = optionalString(object.headerName, `${path}.headerName`, issues);
  const headerValueTemplate = optionalString(object.headerValueTemplate, `${path}.headerValueTemplate`, issues);
  const baseUrl = optionalString(object.baseUrl, `${path}.baseUrl`, issues);
  const apiBaseUrl = optionalString(object.apiBaseUrl, `${path}.apiBaseUrl`, issues);
  if (username !== undefined) credential.username = username;
  if (headerName !== undefined) credential.headerName = headerName;
  if (headerValueTemplate !== undefined) credential.headerValueTemplate = headerValueTemplate;
  if (baseUrl !== undefined) credential.baseUrl = baseUrl.replace(/\/$/, '');
  if (apiBaseUrl !== undefined) credential.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
  if (credential.scheme === 'custom' && (!credential.headerName || !credential.headerValueTemplate)) {
    issues.push(`${path}: custom credential requires headerName and headerValueTemplate.`);
  }
  return credential;
}

function parseDestination(value: unknown, path: string, issues: string[]): DestinationConfig | undefined {
  const object = asObject(value, path, issues);
  if (!object) return undefined;
  const type = provider(object.type, `${path}.type`, issues);
  const mode = nonEmptyString(object.mode, `${path}.mode`, issues);
  const creds = parseCredential(object.creds, `${path}.creds`, issues);
  const org = nonEmptyString(object.org, `${path}.org`, issues);
  const repo = nonEmptyString(object.repo, `${path}.repo`, issues);
  const project = optionalString(object.project, `${path}.project`, issues);
  const baseUrl = optionalString(object.baseUrl, `${path}.baseUrl`, issues);
  if (mode && !MODES.has(mode)) issues.push(`${path}.mode: expected one-to-one or many-to-one.`);
  if (type === 'azure' && !project) issues.push(`${path}.project: required for Azure DevOps.`);
  if ((type === 'gitea' || type === 'custom') && !baseUrl) issues.push(`${path}.baseUrl: required for ${type}.`);
  if (!type || !mode || !MODES.has(mode) || !creds || !org || !repo) return undefined;

  const autoCreateObject = optionalObject(object.autoCreate, `${path}.autoCreate`, issues);
  const autoCreate: { enabled: boolean; private?: boolean; description?: string } = {
    enabled: booleanValue(autoCreateObject?.enabled, `${path}.autoCreate.enabled`, issues, true),
    private: booleanValue(autoCreateObject?.private, `${path}.autoCreate.private`, issues, true),
  };
  const description = optionalString(autoCreateObject?.description, `${path}.autoCreate.description`, issues);
  if (description !== undefined) autoCreate.description = description;

  const pushObject = optionalObject(object.push, `${path}.push`, issues);
  const push: PushPolicy = {
    force: booleanValue(pushObject?.force, `${path}.push.force`, issues, DEFAULT_PUSH.force),
    pushTags: booleanValue(pushObject?.pushTags, `${path}.push.pushTags`, issues, DEFAULT_PUSH.pushTags),
    deleteMissingRefs: booleanValue(
      pushObject?.deleteMissingRefs,
      `${path}.push.deleteMissingRefs`,
      issues,
      DEFAULT_PUSH.deleteMissingRefs,
    ),
    include: stringArray(pushObject?.include, `${path}.push.include`, issues, DEFAULT_PUSH.include),
    exclude: stringArray(pushObject?.exclude, `${path}.push.exclude`, issues, DEFAULT_PUSH.exclude),
  };

  const commitObject = optionalObject(object.commit, `${path}.commit`, issues);
  const commit: CommitConfig = {
    authorName: stringValue(commitObject?.authorName, `${path}.commit.authorName`, issues, DEFAULT_COMMIT.authorName),
    authorEmail: stringValue(commitObject?.authorEmail, `${path}.commit.authorEmail`, issues, DEFAULT_COMMIT.authorEmail),
    committerName: stringValue(
      commitObject?.committerName,
      `${path}.commit.committerName`,
      issues,
      DEFAULT_COMMIT.committerName,
    ),
    committerEmail: stringValue(
      commitObject?.committerEmail,
      `${path}.commit.committerEmail`,
      issues,
      DEFAULT_COMMIT.committerEmail,
    ),
    messagePrefix: stringValue(
      commitObject?.messagePrefix,
      `${path}.commit.messagePrefix`,
      issues,
      DEFAULT_COMMIT.messagePrefix,
    ),
    template: stringValue(commitObject?.template, `${path}.commit.template`, issues, DEFAULT_COMMIT.template),
    trailers: recordOfStrings(commitObject?.trailers, `${path}.commit.trailers`, issues, DEFAULT_COMMIT.trailers),
  };

  const base = {
    enabled: booleanValue(object.enabled, `${path}.enabled`, issues, true),
    type,
    creds,
    org,
    repo,
    autoCreate,
    branch: stringValue(object.branch, `${path}.branch`, issues, 'main'),
    push,
    commit,
  };
  const withOptional = {
    ...base,
    ...(project !== undefined ? { project } : {}),
    ...(baseUrl !== undefined ? { baseUrl: baseUrl.replace(/\/$/, '') } : {}),
  };

  if (mode === 'one-to-one') return { ...withOptional, mode: 'one-to-one' };

  const directory = stringValue(object.directory, `${path}.directory`, issues, '{sourceRepo}');
  const directoryMap = recordOfStrings(object.directoryMap, `${path}.directoryMap`, issues, {});
  for (const [source, mapped] of Object.entries(directoryMap)) {
    try {
      directoryMap[source] = validateDestinationDirectory(mapped);
    } catch (error) {
      issues.push(`${path}.directoryMap.${source}: ${(error as Error).message}`);
    }
  }
  if (!directory.includes('{sourceRepo}') && !directory.includes('{sourceOwner}')) {
    try {
      validateDestinationDirectory(directory);
    } catch (error) {
      issues.push(`${path}.directory: ${(error as Error).message}`);
    }
  }
  try {
    assertDirectoriesDoNotOverlap(Object.entries(directoryMap).map(([id, mapped]) => ({ id, directory: mapped })));
  } catch (error) {
    issues.push(`${path}.directoryMap: ${(error as Error).message}`);
  }
  return { ...withOptional, mode: 'many-to-one', directory, directoryMap };
}

function parseRuntime(value: unknown, issues: string[]): RuntimeConfig {
  const object = optionalObject(value, '$.runtime', issues);
  const logLevel = stringValue(object?.logLevel, '$.runtime.logLevel', issues, DEFAULT_RUNTIME.logLevel);
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    issues.push('$.runtime.logLevel: expected debug, info, warn, or error.');
  }
  const keepaliveObject = optionalObject(object?.codespaceKeepalive, '$.runtime.codespaceKeepalive', issues);
  return {
    workdir: stringValue(object?.workdir, '$.runtime.workdir', issues, DEFAULT_RUNTIME.workdir),
    lockTtlSeconds: integer(object?.lockTtlSeconds, '$.runtime.lockTtlSeconds', issues, DEFAULT_RUNTIME.lockTtlSeconds, 10),
    heartbeatSeconds: integer(
      object?.heartbeatSeconds,
      '$.runtime.heartbeatSeconds',
      issues,
      DEFAULT_RUNTIME.heartbeatSeconds,
      5,
    ),
    maxRetries: integer(object?.maxRetries, '$.runtime.maxRetries', issues, DEFAULT_RUNTIME.maxRetries, 0),
    retryBackoffMs: integer(object?.retryBackoffMs, '$.runtime.retryBackoffMs', issues, DEFAULT_RUNTIME.retryBackoffMs, 0),
    maxEventRetries: integer(object?.maxEventRetries, '$.runtime.maxEventRetries', issues, DEFAULT_RUNTIME.maxEventRetries, 0),
    gitTimeoutMs: integer(object?.gitTimeoutMs, '$.runtime.gitTimeoutMs', issues, DEFAULT_RUNTIME.gitTimeoutMs, 1_000),
    apiTimeoutMs: integer(object?.apiTimeoutMs, '$.runtime.apiTimeoutMs', issues, DEFAULT_RUNTIME.apiTimeoutMs, 1_000),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? (logLevel as RuntimeConfig['logLevel']) : 'info',
    codespaceKeepalive: {
      enabled: booleanValue(
        keepaliveObject?.enabled,
        '$.runtime.codespaceKeepalive.enabled',
        issues,
        DEFAULT_RUNTIME.codespaceKeepalive.enabled,
      ),
      intervalMinutes: integer(
        keepaliveObject?.intervalMinutes,
        '$.runtime.codespaceKeepalive.intervalMinutes',
        issues,
        DEFAULT_RUNTIME.codespaceKeepalive.intervalMinutes,
        1,
      ),
    },
  };
}

function parseSrcFilter(value: unknown, issues: string[]): SrcFilterConfig | undefined {
  const object = optionalObject(value, '$.src.filter', issues);
  if (!object) return undefined;
  const repoExclude = parseFilterExclude(object.repo, '$.src.filter.repo', issues);
  const commitExclude = parseFilterExclude(object.commit, '$.src.filter.commit', issues);
  if (repoExclude.length === 0 && commitExclude.length === 0) return undefined;
  return {
    ...(repoExclude.length > 0 ? { repo: { exclude: repoExclude } } : {}),
    ...(commitExclude.length > 0 ? { commit: { exclude: commitExclude } } : {}),
  };
}

function parseFilterExclude(value: unknown, path: string, issues: string[]): FilterRule[] {
  const object = optionalObject(value, path, issues);
  if (!object) return [];
  const exclude: FilterRule[] = [];
  if (object.exclude !== undefined) {
    if (!Array.isArray(object.exclude)) {
      issues.push(`${path}.exclude: expected array.`);
    } else {
      for (const [index, rule] of object.exclude.entries()) {
        const rulePath = `${path}.exclude[${index}]`;
        const ruleObject = asObject(rule, rulePath, issues);
        if (!ruleObject) continue;
        const mode = nonEmptyString(ruleObject.mode, `${rulePath}.mode`, issues);
        const valueText = nonEmptyString(ruleObject.value, `${rulePath}.value`, issues);
        if (mode && !FILTER_MODES.has(mode as FilterRule['mode'])) {
          issues.push(`${rulePath}.mode: expected prefix, suffix, or contains.`);
        }
        if (mode && valueText && FILTER_MODES.has(mode as FilterRule['mode'])) {
          exclude.push({ mode: mode as FilterRule['mode'], value: valueText });
        }
      }
    }
  }
  return exclude;
}

function parseRtdb(value: unknown, issues: string[]): RtdbPaths {  const object = optionalObject(value, '$.rtdb', issues);
  return {
    configPath: rtdbPath(object?.configPath, '$.rtdb.configPath', issues, DEFAULT_RTDB.configPath),
    webhookPath: rtdbPath(object?.webhookPath, '$.rtdb.webhookPath', issues, DEFAULT_RTDB.webhookPath),
    pendingPath: rtdbPath(object?.pendingPath, '$.rtdb.pendingPath', issues, DEFAULT_RTDB.pendingPath),
    processingPath: rtdbPath(object?.processingPath, '$.rtdb.processingPath', issues, DEFAULT_RTDB.processingPath),
    processedPath: rtdbPath(object?.processedPath, '$.rtdb.processedPath', issues, DEFAULT_RTDB.processedPath),
    failedPath: rtdbPath(object?.failedPath, '$.rtdb.failedPath', issues, DEFAULT_RTDB.failedPath),
    statePath: rtdbPath(object?.statePath, '$.rtdb.statePath', issues, DEFAULT_RTDB.statePath),
    locksPath: rtdbPath(object?.locksPath, '$.rtdb.locksPath', issues, DEFAULT_RTDB.locksPath),
    instancesPath: rtdbPath(object?.instancesPath, '$.rtdb.instancesPath', issues, DEFAULT_RTDB.instancesPath),
    processedByCommitPath: rtdbPath(object?.processedByCommitPath, '$.rtdb.processedByCommitPath', issues, DEFAULT_RTDB.processedByCommitPath),
    retentionDays: integer(object?.retentionDays, '$.rtdb.retentionDays', issues, DEFAULT_RTDB.retentionDays, 1),
  };
}

function crossValidateDestinations(destinations: Record<string, DestinationConfig>, issues: string[]): void {
  const grouped = new Map<string, Array<{ id: string; directory: string }>>();
  for (const [id, destination] of Object.entries(destinations)) {
    if (destination.mode !== 'many-to-one') continue;
    const staticDirectories = Object.values(destination.directoryMap);
    if (!destination.directory.includes('{')) staticDirectories.push(destination.directory);
    const target = `${destination.type}/${destination.org}/${destination.project ?? ''}/${destination.repo}`;
    const entries = grouped.get(target) ?? [];
    entries.push(...staticDirectories.map((directory, index) => ({ id: `${id}#${index}`, directory })));
    grouped.set(target, entries);
  }
  for (const [target, entries] of grouped) {
    try {
      assertDirectoriesDoNotOverlap(entries);
    } catch (error) {
      issues.push(`$.dest: overlapping many-to-one directories for ${target}: ${(error as Error).message}`);
    }
  }
}

function asObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path}: expected object.`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asObject(value, path, issues);
}

function provider(value: unknown, path: string, issues: string[]): ProviderType | undefined {
  const result = nonEmptyString(value, path, issues);
  if (!result) return undefined;
  if (!PROVIDERS.has(result as ProviderType)) {
    issues.push(`${path}: unsupported provider ${result}.`);
    return undefined;
  }
  return result as ProviderType;
}

function nonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path}: expected non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function optionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    issues.push(`${path}: expected string.`);
    return undefined;
  }
  return value.trim();
}

function stringValue(value: unknown, path: string, issues: string[], fallback: string): string {
  if (value === undefined) return fallback;
  return nonEmptyString(value, path, issues) ?? fallback;
}

function booleanValue(value: unknown, path: string, issues: string[], fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.push(`${path}: expected boolean.`);
    return fallback;
  }
  return value;
}

function integer(value: unknown, path: string, issues: string[], fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum) {
    issues.push(`${path}: expected integer >= ${minimum}.`);
    return fallback;
  }
  return value as number;
}

function stringArray(value: unknown, path: string, issues: string[], fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push(`${path}: expected string array.`);
    return [...fallback];
  }
  return value as string[];
}

function recordOfStrings(
  value: unknown,
  path: string,
  issues: string[],
  fallback: Record<string, string>,
): Record<string, string> {
  if (value === undefined) return { ...fallback };
  const object = asObject(value, path, issues);
  if (!object) return { ...fallback };
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'string' || item.trim() === '') issues.push(`${path}.${key}: expected non-empty string.`);
    else result[key] = item;
  }
  return result;
}

function rtdbPath(value: unknown, path: string, issues: string[], fallback: string): string {
  const resolved = stringValue(value, path, issues, fallback);
  if (!resolved.startsWith('/')) issues.push(`${path}: RTDB path must start with /.`);
  return resolved.replace(/\/$/, '');
}
