import type { CredentialConfig } from '../types.js';
import { toPublicError, type AppError } from '../shared/errors.js';
import { runGit, validateSourceUrl } from './workspace.js';

export interface RemoteRefsResult {
  ok: boolean;
  refs: Map<string, string>;
  error?: ReturnType<typeof toPublicError>;
}

export async function listRemoteRefs(
  url: string,
  credential: CredentialConfig,
  timeoutMs: number,
  cwd = process.cwd(),
): Promise<RemoteRefsResult> {
  validateSourceUrl(url);
  try {
    const result = await runGit(['ls-remote', '--heads', '--tags', url], {
      cwd,
      credential,
      timeoutMs,
    });
    return { ok: true, refs: parseLsRemote(result.stdout) };
  } catch (error) {
    return { ok: false, refs: new Map(), error: toPublicError(error as AppError) };
  }
}

export function parseLsRemote(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/, 2);
    if (!sha || !ref || ref.endsWith('^{}')) continue;
    refs.set(ref, sha);
  }
  return refs;
}
