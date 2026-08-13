#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkRepositories } from './app/check.js';
import { initRepositories } from './app/init.js';
import { resolveInstanceId, runWorker } from './app/run.js';
import { createShutdownController } from './app/shutdown.js';
import { decodeBase64, encodeConfig, loadConfig } from './config/load.js';
import { createRtdbClientFromEnv, type RtdbClient } from './rtdb/client.js';
import { replayEvent } from './rtdb/events.js';
import { toPublicError } from './shared/errors.js';
import { createLogger } from './shared/logger.js';
import { processHookEvent } from './sync/router.js';
import { bridgeOnce, bridgePendingEvents } from './webhook/github-bridge.js';
import { reconcileRepositories } from './reconcile/manual.js';
import type { AppConfig, HookEvent } from './types.js';
import { handleCodespaceCommand, isCodespaceCommand } from './codespace/cli.js';
import { isHelpRequest, parseCliArgs, type ParsedArgs } from './cli-args.js';

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (isHelpRequest(parsed)) {
    printHelp();
    return;
  }

  if (isCodespaceCommand(parsed.command)) {
    await handleCodespaceCommand(parsed);
    return;
  }

  if (parsed.command === 'config:encode') {
    const file = requiredValue(parsed.positionals[0], 'config:encode requires a JSON file path.');
    const raw = await readFile(resolve(file), 'utf8');
    console.log(encodeConfig(raw));
    return;
  }
  if (parsed.command === 'config:decode') {
    const file = requiredValue(parsed.positionals[0], 'config:decode requires a base64 file path.');
    console.log(decodeBase64(await readFile(resolve(file), 'utf8')));
    return;
  }

  if (parsed.command === 'config:push') {
    const client = await createRtdbClientFromEnv();
    const file = requiredValue(parsed.positionals[0] ?? stringOption(parsed.options, 'config'), 'config:push requires a JSON file.');
    const raw = await readFile(resolve(file), 'utf8');
    const config = await loadConfig({ file: resolve(file) });
    await client.set(config.rtdb.configPath, encodeConfig(raw));
    console.log(JSON.stringify({ status: 'pushed', path: config.rtdb.configPath }, null, 2));
    return;
  }

  if (parsed.command === 'config:pull') {
    const client = await createRtdbClientFromEnv();
    const rtdbPath = stringOption(parsed.options, 'path') ?? process.env.RTDB_CONFIG_PATH ?? '/sync/config';
    const value = await client.get<string>(rtdbPath);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`config:pull: RTDB node "${rtdbPath}" does not contain a base64 config string.`);
    }
    const json = decodeBase64(value);
    const outFile = parsed.positionals[0] ?? stringOption(parsed.options, 'output');
    if (outFile) {
      await writeFile(resolve(outFile), json, 'utf8');
      console.log(JSON.stringify({ status: 'pulled', path: rtdbPath, file: resolve(outFile) }, null, 2));
    } else {
      console.log(json);
    }
    return;
  }

  const client = ['run', 'replay', 'webhook:bridge', 'reconcile'].includes(parsed.command) ? await createRtdbClientFromEnv() : await optionalRtdbClient();
  const config = await loadCommandConfig(parsed, client);
  const logger = createLogger(config.runtime.logLevel, { service: 'git-mirror' });

  if (parsed.command === 'validate') {
    console.log(JSON.stringify({ status: 'ok', configVersion: config.configVersion, destinations: Object.keys(config.dest) }, null, 2));
    return;
  }
  if (parsed.command === 'repo:check') {
    const hook = await loadOptionalEvent(parsed.options);
    const results = await checkRepositories({ config, hook });
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.some((item) => item.status === 'error') ? 1 : 0;
    return;
  }
  if (parsed.command === 'repo:init' || parsed.command === 'init') {
    const hook = await loadOptionalEvent(parsed.options);
    const results = await initRepositories({
      config,
      hook,
      dryRun: Boolean(parsed.options['dry-run']),
      rtdb: client,
    });
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.some((item) => item.status === 'error') ? 1 : 0;
    return;
  }
  if (parsed.command === 'sync') {
    const hook = await loadRequiredEvent(parsed.options);
    const result = await processHookEvent({
      config,
      hook,
      instanceId: resolveInstanceId(),
      logger,
      rtdb: client,
      dryRun: Boolean(parsed.options['dry-run']),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (parsed.command === 'reconcile') {
    if (!client) throw new Error('reconcile requires RTDB credentials.');
    const result = await reconcileRepositories({
      config,
      client,
      logger,
      dryRun: Boolean(parsed.options['dry-run']),
      sourceCredentialId: stringOption(parsed.options, 'source'),
      owners: csvOption(parsed.options, 'owner'),
      orgs: csvOption(parsed.options, 'orgs'),
      repos: csvOption(parsed.options, 'repo'),
      destinations: csvOption(parsed.options, 'dest'),
      repoDelayMs: numberOption(parsed.options, 'delay-ms', 500),
      apiDelayMs: numberOption(parsed.options, 'api-delay-ms', 250),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.errors > 0 ? 1 : 0;
    return;
  }
  if (parsed.command === 'replay') {
    if (!client) throw new Error('replay requires RTDB credentials.');
    const eventId = requiredValue(stringOption(parsed.options, 'event'), 'replay requires --event <id>.');
    await replayEvent(client, config.rtdb, eventId);
    console.log(JSON.stringify({ status: 'replayed', eventId }, null, 2));
    return;
  }
  if (parsed.command === 'webhook:bridge') {
    if (!client) throw new Error('webhook:bridge requires RTDB credentials.');
    const webhookOptions = {
      client,
      config,
      logger,
      webhookPath: process.env.WEBHOOK_PATH ?? config.rtdb.webhookPath,
    };
    if (parsed.options.once) {
      const result = await bridgeOnce(webhookOptions);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const caughtUp = await bridgeOnce(webhookOptions);
    logger.info({ processed: caughtUp.processed, skipped: caughtUp.skipped }, 'webhook.catchup_done');
    const bridge = bridgePendingEvents(webhookOptions);
    const shutdown = createShutdownController();
    await shutdown.wait();
    bridge.stop();
    await bridge.idle();
    shutdown.dispose();
    return;
  }
  if (parsed.command === 'run') {
    if (!client) throw new Error('run requires RTDB credentials.');
    const result = await runWorker({
      config,
      client,
      logger,
      once: Boolean(parsed.options.once),
      dryRun: Boolean(parsed.options['dry-run']),
      bridge: Boolean(parsed.options.bridge),
      reloadConfig: configFromRtdb(parsed),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${parsed.command}`);
}

async function loadCommandConfig(parsed: ParsedArgs, client?: RtdbClient): Promise<AppConfig> {
  return loadConfig({
    raw: stringOption(parsed.options, 'config-json'),
    file: stringOption(parsed.options, 'config'),
    rtdb: client,
    rtdbPath: process.env.RTDB_CONFIG_PATH,
  });
}

function configFromRtdb(parsed: ParsedArgs): boolean {
  if (process.env.CONFIG_AUTO_RELOAD === '0') return false;
  if (stringOption(parsed.options, 'config-json') || process.env.CONFIG_JSON) return false;
  if (stringOption(parsed.options, 'config') || process.env.CONFIG_FILE) return false;
  return true;
}

async function loadOptionalEvent(options: Record<string, string | boolean>): Promise<HookEvent | undefined> {
  const file = stringOption(options, 'event-file');
  const raw = stringOption(options, 'event-json');
  if (!file && !raw) return undefined;
  return parseEvent(raw ?? (await readFile(resolve(file ?? ''), 'utf8')));
}

async function loadRequiredEvent(options: Record<string, string | boolean>): Promise<HookEvent> {
  const event = await loadOptionalEvent(options);
  if (!event) throw new Error('sync requires --event-file <path> or --event-json <json>.');
  return event;
}

function parseEvent(raw: string): HookEvent {
  const value = JSON.parse(raw) as HookEvent;
  value.eventId ??= `manual-${Date.now()}`;
  value.receivedAt ??= Date.now();
  return value;
}


async function optionalRtdbClient(): Promise<RtdbClient | undefined> {
  if (!process.env.RTDB_URL || (!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !process.env.RTDB_AUTH_SECRET)) return undefined;
  return createRtdbClientFromEnv();
}

function stringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function csvOption(options: Record<string, string | boolean>, key: string): string[] | undefined {
  const value = stringOption(options, key);
  if (!value) return undefined;
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

function numberOption(options: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = stringOption(options, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a number >= 0.`);
  return parsed;
}

function requiredValue<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === '') throw new Error(message);
  return value;
}

function printHelp(): void {
  console.log(`git-mirror commands:
  validate --config <file> | --config-json <json>
  repo:check [--event-file <file>]
  repo:init [--event-file <file>] [--dry-run]
  run [--once] [--dry-run] [--bridge]
  webhook:bridge [--once]
  sync --event-file <file> [--dry-run]
  reconcile [--source <credential>] [--orgs <org[,org]>] [--owner <owner[,owner]>] [--repo <repo[,repo]>] [--dest <id[,id]>] [--delay-ms 500] [--api-delay-ms 250] [--dry-run]
  replay --event <eventId>
  config:encode <config.json>
  config:decode <config.b64>
  config:push <config.json>
  config:pull [<output.json>] [--path <rtdb-path>]
  codespace:plan --rotation-config <file> [--date YYYY-MM-DD]
  codespace:preflight --rotation-config <file> [--date YYYY-MM-DD]
  codespace:rotate [--date YYYY-MM-DD] [--fake] [--no-stop-old]
  codespace:status [--date YYYY-MM-DD]
  codespace:rollback --rotation YYYY-MM-DD
  codespace:cleanup --rotation YYYY-MM-DD
  codespace:config:encode <rotation.json>
  codespace:config:push <rotation.json>

Config precedence: --config-json/CONFIG_JSON, --config/CONFIG_FILE, RTDB base64 config.`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: toPublicError(error) }, null, 2));
  process.exitCode = 1;
});
