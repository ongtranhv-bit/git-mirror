import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RtdbClient } from '../rtdb/client.js';
import { createRtdbClientFromEnv } from '../rtdb/client.js';
import { createLogger } from '../shared/logger.js';
import { AppError } from '../shared/errors.js';
import { loadRotationConfig, encodeRotationConfig, resolveDayConfig, resolveRotationDay, dateForRotationKey } from './config.js';
import { resolveLifecycleCredential } from './credentials.js';
import { FakeCodespaceLifecycle } from './fake-lifecycle.js';
import { GitHubCodespaceLifecycle } from './github-lifecycle.js';
import { cleanupCodespaceRotation, rollbackCodespaceRotation, rotateCodespace } from './rotation.js';
import { rotationPaths } from './state.js';
import type { CodespaceInfo, CreateCodespaceInput, RotationRecord, RuntimeReadinessRecord } from './types.js';

export interface CodespaceParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

export function isCodespaceCommand(command: string): boolean {
  return command.startsWith('codespace:');
}

export async function handleCodespaceCommand(parsed: CodespaceParsedArgs): Promise<void> {
  const client = needsRtdb(parsed) ? await createRtdbClientFromEnv() : await optionalRtdbClient();
  if (parsed.command === 'codespace:config:encode') {
    const file = stringOption(parsed.options, 'rotation-config') ?? parsed.positionals[0];
    if (!file) throw new AppError('CODESPACE_CONFIG_FILE_REQUIRED', 'codespace:config:encode requires a config file.');
    console.log(encodeRotationConfig(await readFile(resolve(file), 'utf8')));
    return;
  }
  if (parsed.command === 'codespace:config:push') {
    if (!client) throw new AppError('RTDB_AUTH_MISSING', 'codespace:config:push requires RTDB credentials.');
    const file = stringOption(parsed.options, 'rotation-config') ?? parsed.positionals[0];
    if (!file) throw new AppError('CODESPACE_CONFIG_FILE_REQUIRED', 'codespace:config:push requires a config file.');
    const raw = await readFile(resolve(file), 'utf8');
    await loadRotationConfig({ raw, env: process.env });
    const path = process.env.CODESPACE_ROTATION_CONFIG_PATH ?? '/sync/codespace/config';
    await client.set(path, encodeRotationConfig(raw));
    console.log(JSON.stringify({ status: 'pushed', path }, null, 2));
    return;
  }

  const config = await loadRotationConfig({
    raw: stringOption(parsed.options, 'rotation-config-json'),
    file: stringOption(parsed.options, 'rotation-config'),
    rtdb: client,
    rtdbPath: process.env.CODESPACE_ROTATION_CONFIG_PATH,
    env: process.env,
  });
  const logger = createLogger((process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info', { service: 'git-mirror-codespace' });
  const date = parseDateOption(stringOption(parsed.options, 'date'), config);
  const resolved = resolveRotationDay(config, date);
  const selectedDay = config.testing.enabled && config.testing.tokenDay ? config.testing.tokenDay : resolved.dayOfMonth;
  const day = resolveDayConfig(config, selectedDay);

  if (parsed.command === 'codespace:plan') {
    console.log(JSON.stringify({
      status: 'planned',
      rotationKey: resolved.rotationKey,
      dayOfMonth: resolved.dayOfMonth,
      selectedCredentialDay: selectedDay,
      lifecycleCredentialEnv: day.codespaceAccount.tokenEnv,
      expectedLogin: day.codespaceAccount.expectedLogin,
      bootstrap: config.bootstrap,
      stopOldAfterHealthy: Boolean(!parsed.options['no-stop-old'] && config.runtime.stopOldAfterHealthy),
      deleteOldAfterStop: config.runtime.deleteOldAfterStop,
      testing: config.testing,
    }, null, 2));
    return;
  }

  if (parsed.command === 'codespace:preflight') {
    const credential = resolveLifecycleCredential(day);
    const lifecycle = new GitHubCodespaceLifecycle(credential.token);
    const identity = await lifecycle.getAuthenticatedUser();
    if (identity.login !== credential.expectedLogin) {
      throw new AppError('CODESPACE_TOKEN_IDENTITY_MISMATCH', `Lifecycle credential resolved to ${identity.login}, expected ${credential.expectedLogin}.`);
    }
    const head = await lifecycle.resolveRepositoryHead(config.bootstrap.owner, config.bootstrap.repo, config.bootstrap.branch);
    const machines = await lifecycle.listMachines(config.bootstrap.owner, config.bootstrap.repo);
    const machineOk = !config.bootstrap.machine || machines.some((item) => item.name === config.bootstrap.machine);
    if (!machineOk) throw new AppError('CODESPACE_MACHINE_UNAVAILABLE', `Configured machine ${config.bootstrap.machine} is unavailable.`);
    console.log(JSON.stringify({ status: 'ok', identity: identity.login, repository: `${config.bootstrap.owner}/${config.bootstrap.repo}`, branch: config.bootstrap.branch, head, machine: config.bootstrap.machine ?? null, availableMachines: machines.map((item) => item.name) }, null, 2));
    return;
  }

  if (!client) throw new AppError('RTDB_AUTH_MISSING', `${parsed.command} requires RTDB credentials.`);
  if (parsed.command === 'codespace:status') {
    const paths = rotationPaths(process.env.CODESPACE_ROTATION_BASE_PATH);
    const [active, record, lock] = await Promise.all([
      client.get(paths.active),
      client.get<RotationRecord>(`${paths.rotations}/${resolved.rotationKey}`),
      client.get(paths.lock),
    ]);
    console.log(JSON.stringify({ rotationKey: resolved.rotationKey, active, record, lock }, null, 2));
    return;
  }


  if (parsed.command === 'codespace:rollback' || parsed.command === 'codespace:cleanup') {
    const rotationKey = stringOption(parsed.options, 'rotation') ?? resolved.rotationKey;
    const ownerId = process.env.INSTANCE_ID?.trim() || `orchestrator-${process.pid}`;
    const operationInput = {
      config, client, logger, ownerId, env: process.env, basePath: process.env.CODESPACE_ROTATION_BASE_PATH,
    };
    const record = parsed.command === 'codespace:rollback'
      ? await rollbackCodespaceRotation(operationInput, rotationKey)
      : await cleanupCodespaceRotation(operationInput, rotationKey);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  if (parsed.command === 'codespace:rotate') {
    const ownerId = process.env.INSTANCE_ID?.trim() || `orchestrator-${process.pid}`;
    const fake = Boolean(parsed.options.fake);
    if (config.testing.enabled && !config.testing.useRealCodespace && !fake) {
      throw new AppError('CODESPACE_TEST_REAL_CREATE_BLOCKED', 'Testing config has useRealCodespace=false; pass --fake instead of calling the real Codespaces API.');
    }
    const record = await rotateCodespace({
      config,
      client,
      logger,
      ownerId,
      date,
      env: process.env,
      basePath: process.env.CODESPACE_ROTATION_BASE_PATH,
      noStopOld: Boolean(parsed.options['no-stop-old']),
      displayNamePrefix: config.testing.enabled ? 'git-mirror-test' : 'git-mirror',
      ...(fake ? { lifecycleFactory: createAutoReadyFakeFactory(client, config.bootstrap.owner, config.bootstrap.repo, process.env.CODESPACE_ROTATION_BASE_PATH) } : {}),
    });
    console.log(JSON.stringify(record, null, 2));
    if (record.status === 'cleanup_pending' || record.status === 'rollback_pending' || record.status === 'failed') {
      process.exitCode = 2;
    }
    return;
  }

  throw new AppError('CODESPACE_COMMAND_UNKNOWN', `Unknown Codespace command: ${parsed.command}`);
}

function createAutoReadyFakeFactory(client: RtdbClient, owner: string, repo: string, basePath?: string) {
  const instancesPath = rotationPaths(basePath).instances;
  return (_profile: string, _token: string) => new AutoReadyFakeLifecycle(client, owner, repo, instancesPath);
}

class AutoReadyFakeLifecycle extends FakeCodespaceLifecycle {
  constructor(private readonly client: RtdbClient, private readonly owner: string, private readonly repo: string, private readonly instancesPath: string) {
    super({ login: process.env.CODESPACE_FAKE_LOGIN ?? 'test-user', repositoryHead: process.env.CODESPACE_FAKE_SHA ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  }

  override async create(input: CreateCodespaceInput): Promise<CodespaceInfo> {
    const created = await super.create(input);
    const sha = await this.resolveRepositoryHead(this.owner, this.repo, input.branch);
    const readiness: RuntimeReadinessRecord = {
      instanceId: `fake-instance-${created.name}`,
      codespaceName: created.name,
      status: 'ready',
      repository: `${this.owner}/${this.repo}`,
      branch: input.branch,
      runtimeCommitSha: sha,
      serviceVersion: 'fake',
      rtdbConnected: true,
      listenerAttached: true,
      startedAt: Date.now(),
      readyAt: Date.now(),
      heartbeatAt: Date.now(),
      currentEvent: null,
    };
    await this.client.set(`${this.instancesPath}/${readiness.instanceId}`, readiness);
    return created;
  }
}

async function optionalRtdbClient(): Promise<RtdbClient | undefined> {
  if (!process.env.RTDB_URL || (!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !process.env.RTDB_AUTH_SECRET)) return undefined;
  return createRtdbClientFromEnv();
}

function needsRtdb(parsed: CodespaceParsedArgs): boolean {
  if (['codespace:config:push', 'codespace:rotate', 'codespace:status', 'codespace:rollback', 'codespace:cleanup'].includes(parsed.command)) return true;
  return !stringOption(parsed.options, 'rotation-config') && !stringOption(parsed.options, 'rotation-config-json');
}

function stringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function parseDateOption(value: string | undefined, config: import('./types.js').RotationConfig): Date {
  return value ? dateForRotationKey(config, value) : new Date();
}
