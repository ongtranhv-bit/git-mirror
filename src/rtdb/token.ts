import { createSign, randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { registerSecret } from '../shared/logger.js';
import type { AuthTokenProvider } from './rest-client.js';

export function createServiceAccountTokenProvider(serviceAccountBase64: string): AuthTokenProvider {
  let serviceAccount: {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
  try {
    serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8')) as typeof serviceAccount;
  } catch (error) {
    throw new AppError('SERVICE_ACCOUNT_INVALID', 'GOOGLE_SERVICE_ACCOUNT_B64 is not valid base64 JSON.', { cause: error });
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new AppError('SERVICE_ACCOUNT_INVALID', 'Service account requires client_email and private_key.');
  }
  registerSecret(serviceAccount.private_key);
  let cached: { token: string; expiresAt: number } | undefined;

  return {
    getQueryAuth: async () => undefined,
    getBearerToken: async () => {
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
      const now = Math.floor(Date.now() / 1_000);
      const assertion = signJwt(
        {
          iss: serviceAccount.client_email,
          scope:
            'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
          aud: serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3_600,
          jti: randomUUID(),
        },
        serviceAccount.private_key,
      );
      const response = await fetch(serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!response.ok || !body.access_token) {
        throw new AppError('SERVICE_ACCOUNT_TOKEN_FAILED', body.error_description ?? `OAuth token request failed: ${response.status}`, {
          status: response.status,
          retryable: response.status >= 500,
        });
      }
      registerSecret(body.access_token);
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000 };
      return cached.token;
    },
  };
}

function signJwt(payload: Record<string, unknown>, privateKey: string): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}