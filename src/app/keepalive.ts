import { spawnSync } from 'node:child_process';
import type { Logger } from '../shared/logger.js';
import type { CodespaceKeepaliveConfig } from '../types.js';

export interface KeepaliveDeps {
  env: NodeJS.ProcessEnv;
  ghAvailable: () => boolean;
  ping: (codespaceName: string) => { status: number | null; stderr: string; durationMs: number };
}

export interface KeepaliveHandle {
  started: boolean;
  reason?: string;
  stop: () => void;
}

export interface KeepaliveInput {
  config: CodespaceKeepaliveConfig;
  logger: Logger;
  deps?: Partial<KeepaliveDeps>;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function evaluateKeepaliveGuards(env: NodeJS.ProcessEnv, ghAvailable: boolean): GuardResult {
  if (env.CODESPACES !== 'true') {
    return { ok: false, reason: 'CODESPACES is not true (not a GitHub Codespace)' };
  }
  const name = env.CODESPACE_NAME?.trim();
  if (!name) {
    return { ok: false, reason: 'CODESPACE_NAME is not set' };
  }
  if (!ghAvailable) {
    return { ok: false, reason: 'gh CLI is not available on PATH' };
  }
  return { ok: true };
}

export function startCodespaceKeepalive(input: KeepaliveInput): KeepaliveHandle {
  const deps: KeepaliveDeps = {
    env: process.env,
    ghAvailable: () => spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0,
    ping: (codespaceName) => {
      const startedAt = Date.now();
      const result = spawnSync('gh', ['codespace', 'ssh', '-c', codespaceName, '--', 'true'], {
        timeout: 30_000,
        encoding: 'utf8',
      });
      return {
        status: result.status,
        stderr: (result.stderr ?? '').toString().slice(0, 300),
        durationMs: Date.now() - startedAt,
      };
    },
    ...input.deps,
  };

  if (!input.config.enabled) {
    input.logger.info({}, 'codespace.keepalive_disabled');
    return { started: false, reason: 'disabled', stop: () => {} };
  }

  const guards = evaluateKeepaliveGuards(deps.env, deps.ghAvailable());
  if (!guards.ok) {
    input.logger.warn({ reason: guards.reason }, 'codespace.keepalive_skipped');
    return { started: false, reason: guards.reason, stop: () => {} };
  }

  const codespaceName = deps.env.CODESPACE_NAME!.trim();
  const intervalMs = Math.max(60_000, input.config.intervalMinutes * 60_000);

  const pingOnce = () => {
    const result = deps.ping(codespaceName);
    if (result.status === 0) {
      input.logger.info({ codespaceName, durationMs: result.durationMs }, 'codespace.keepalive_ping_ok');
    } else {
      input.logger.warn(
        { codespaceName, status: result.status, stderr: result.stderr },
        'codespace.keepalive_ping_failed',
      );
    }
  };

  pingOnce();
  const timer = setInterval(pingOnce, intervalMs);
  timer.unref();

  return {
    started: true,
    stop: () => clearInterval(timer),
  };
}
