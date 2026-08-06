#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
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
import type { AppConfig, HookEvent } from './types.js';

interface ParsedArgs {
  command: string;
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    if (!rawKey) continue;
    if (inline !== undefined) options[rawKey] = inline;
    else if (argv[index + 1] && !argv[index + 1]?.startsWith('--')) {
      options[rawKey] = argv[index + 1] ?? '';
      index += 1;
    } else options[rawKey] = true;
  }
  return { command, positionals, options };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.options.help) {
    printHelp();
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
    const client = createRtdbClientFromEnv();
    const file = requiredValue(parsed.positionals[0] ?? stringOption(parsed.options, 'config'), 'config:push requires a JSON file.');
    const raw = await readFile(resolve(file), 'utf8');
    const config = await loadConfig({ file: resolve(file) });
    await client.set(config.rtdb.configPath, encodeConfig(raw));
    console.log(JSON.stringify({ status: 'pushed', path: config.rtdb.configPath }, null, 2));
    return;
  }

  const client = ['run', 'replay', 'webhook:bridge'].includes(parsed.command) ? createRtdbClientFromEnv() : optionalRtdbClient();
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
      webhookPath: process.env.WEBHOOK_PATH ?? '/github-noti',
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


function optionalRtdbClient(): RtdbClient | undefined {
  if (!process.env.RTDB_URL || (!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !process.env.RTDB_AUTH_SECRET)) return undefined;
  return createRtdbClientFromEnv();
}

function stringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
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
  run [--once] [--dry-run]
  webhook:bridge [--once]
  sync --event-file <file> [--dry-run]
  replay --event <eventId>
  config:encode <config.json>
  config:decode <config.b64>
  config:push <config.json>

Config precedence: --config-json/CONFIG_JSON, --config/CONFIG_FILE, RTDB base64 config.`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: toPublicError(error) }, null, 2));
  process.exitCode = 1;
});
