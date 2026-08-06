import type { CredentialConfig } from '../types.js';
import { AppError } from '../shared/errors.js';

export interface HeaderValue {
  name: string;
  value: string;
}

export function buildAuthorizationHeader(
  credential: CredentialConfig,
  purpose: 'git' | 'api' = 'git',
): HeaderValue {
  const scheme = credential.scheme ?? defaultScheme(credential.type, purpose);
  if (scheme === 'custom') {
    if (!credential.headerName || !credential.headerValueTemplate) {
      throw new AppError('AUTH_CONFIG_INVALID', 'Custom credential requires headerName and headerValueTemplate.');
    }
    return {
      name: credential.headerName,
      value: credential.headerValueTemplate
        .replaceAll('{{token}}', credential.token)
        .replaceAll('{{username}}', credential.username ?? ''),
    };
  }
  if (scheme === 'bearer') return { name: 'Authorization', value: `Bearer ${credential.token}` };
  if (scheme === 'token') return { name: 'Authorization', value: `token ${credential.token}` };
  const username = credential.username ?? defaultUsername(credential.type);
  return {
    name: 'Authorization',
    value: `Basic ${Buffer.from(`${username}:${credential.token}`, 'utf8').toString('base64')}`,
  };
}

export function gitCredentialEnv(
  credential: CredentialConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const header = buildAuthorizationHeader(credential, 'git');
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `${header.name}: ${header.value}`,
  };
}

export function apiHeaders(credential: CredentialConfig): Record<string, string> {
  const header = buildAuthorizationHeader(credential, 'api');
  return { [header.name]: header.value };
}

function defaultScheme(type: CredentialConfig['type'], purpose: 'git' | 'api'): NonNullable<CredentialConfig['scheme']> {
  if (type === 'github') return purpose === 'git' ? 'basic' : 'bearer';
  if (type === 'azure') return 'basic';
  if (type === 'gitea') return purpose === 'api' ? 'token' : 'basic';
  return 'basic';
}

function defaultUsername(type: CredentialConfig['type']): string {
  if (type === 'github') return 'x-access-token';
  if (type === 'azure') return '';
  return 'git';
}
