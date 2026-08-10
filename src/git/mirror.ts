import type { CredentialConfig, PushPolicy } from '../types.js';
import { AppError } from '../shared/errors.js';
import { runGit } from './workspace.js';
import { parseLsRemote } from './remote-refs.js';

export async function pushMirror(
  workspace: string,
  remoteName: string,
  credential: CredentialConfig,
  policy: PushPolicy,
  timeoutMs: number,
): Promise<void> {
  const refsResult = await runGit(['for-each-ref', '--format=%(objectname)%09%(refname)', 'refs/heads', 'refs/tags'], {
    cwd: workspace,
    timeoutMs,
  });
  const localRefs = new Map<string, string>();
  for (const line of refsResult.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (sha && ref) localRefs.set(ref, sha);
  }
  const refs = refsForPushPolicy(localRefs, policy);
  if (refs.size === 0) throw new AppError('GIT_NO_REFS', 'No refs matched the configured push policy.');

  const prefix = policy.force ? '+' : '';
  const refspecs = [...refs.keys()].map((ref) => `${prefix}${ref}:${ref}`);

  if (policy.deleteMissingRefs) {
    const remoteResult = await runGit(['ls-remote', '--heads', '--tags', remoteName], {
      cwd: workspace,
      credential,
      timeoutMs,
    });
    const remoteRefs = refsForPushPolicy(parseLsRemote(remoteResult.stdout), policy);
    for (const ref of remoteRefs.keys()) {
      if (!refs.has(ref)) refspecs.push(`:${ref}`);
    }
  }

  const pushed = await runGit(['push', remoteName, ...refspecs], { cwd: workspace, credential, timeoutMs, allowFailure: true });
  if (pushed.exitCode === 0) return;
  if (!isMissingPartialCloneObject(pushed.stderr) && !isMissingPartialCloneObject(pushed.stdout)) {
    throw new AppError('GIT_COMMAND_FAILED', 'Git push failed.', {
      context: { command: 'git push', stdout: pushed.stdout, stderr: pushed.stderr, exitCode: pushed.exitCode },
    });
  }
  await runGit(['fetch', '--prune', '--tags', '--unshallow', 'origin'], { cwd: workspace, credential, timeoutMs, allowFailure: true });
  await runGit(['fetch', '--prune', '--tags', 'origin'], { cwd: workspace, credential, timeoutMs });
  await runGit(['push', remoteName, ...refspecs], { cwd: workspace, credential, timeoutMs });
}

function isMissingPartialCloneObject(output: string): boolean {
  return /missing|promisor|filter|could not read|unable to read|bad object/i.test(output);
}

export function refsForPushPolicy(refs: Map<string, string>, policy: PushPolicy): Map<string, string> {
  const selected = new Map<string, string>();
  for (const [ref, sha] of refs) {
    if (!refMatchesPushPolicy(ref, policy)) continue;
    selected.set(ref, sha);
  }
  return selected;
}

export function refMatchesPushPolicy(ref: string, policy: PushPolicy): boolean {
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return false;
  if (!policy.pushTags && ref.startsWith('refs/tags/')) return false;
  if (!matchesAny(ref, policy.include)) return false;
  if (policy.exclude.some((pattern) => globToRegExp(pattern).test(ref))) return false;
  return true;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}
