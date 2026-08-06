import type { CredentialConfig, PushPolicy } from '../types.js';
import { AppError } from '../shared/errors.js';
import { runGit } from './workspace.js';

export async function pushMirror(
  workspace: string,
  remoteName: string,
  credential: CredentialConfig,
  policy: PushPolicy,
  timeoutMs: number,
): Promise<void> {
  const refsResult = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'], {
    cwd: workspace,
    timeoutMs,
  });
  const refs = refsResult.stdout
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((ref) => policy.pushTags || !ref.startsWith('refs/tags/'))
    .filter((ref) => matchesAny(ref, policy.include))
    .filter((ref) => policy.exclude.length === 0 || !policy.exclude.some((pattern) => globToRegExp(pattern).test(ref)));
  if (refs.length === 0) throw new AppError('GIT_NO_REFS', 'No refs matched the configured push policy.');
  const prefix = policy.force ? '+' : '';
  const refspecs = refs.map((ref) => `${prefix}${ref}:${ref}`);
  const args = ['push'];
  if (policy.deleteMissingRefs) args.push('--prune');
  args.push(remoteName, ...refspecs);
  await runGit(args, { cwd: workspace, credential, timeoutMs });
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}
