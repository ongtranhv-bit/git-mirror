import { AppError } from '../shared/errors.js';
import { registerSecret } from '../shared/logger.js';
import type { RotationDayConfig } from './types.js';

export interface ResolvedLifecycleCredential {
  token: string;
  expectedLogin: string;
  profile: string;
}

export function resolveLifecycleCredential(day: RotationDayConfig, env: NodeJS.ProcessEnv = process.env): ResolvedLifecycleCredential {
  return {
    token: resolveLifecycleToken(day.codespaceAccount.tokenEnv, env),
    expectedLogin: day.codespaceAccount.expectedLogin,
    profile: day.codespaceAccount.tokenEnv,
  };
}

export function resolveLifecycleToken(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const direct = env[profile]?.trim();
  if (direct) {
    registerSecret(direct);
    return direct;
  }
  const encoded = env.CODESPACE_LIFECYCLE_TOKENS_B64?.trim();
  if (encoded) {
    registerSecret(encoded);
    let map: unknown;
    try {
      map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch (error) {
      throw new AppError('CODESPACE_LIFECYCLE_TOKEN_MAP_INVALID', 'CODESPACE_LIFECYCLE_TOKENS_B64 must be base64 JSON.', { cause: error });
    }
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new AppError('CODESPACE_LIFECYCLE_TOKEN_MAP_INVALID', 'Lifecycle token map must be a JSON object.');
    }
    const token = (map as Record<string, unknown>)[profile];
    if (typeof token === 'string' && token.trim()) {
      registerSecret(token.trim());
      return token.trim();
    }
  }
  throw new AppError('CODESPACE_LIFECYCLE_TOKEN_MISSING', `Missing lifecycle credential profile ${profile}.`);
}
