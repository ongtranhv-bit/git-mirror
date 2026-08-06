import type { CommitFilterMode, CommitFilterRule, SrcFilterConfig } from './types.js';

const FILTER_MODES: CommitFilterMode[] = ['prefix', 'suffix', 'contains'];

export interface CommitFilterMatch {
  matched: boolean;
  rule?: CommitFilterRule;
}

export function commitMessagesOf(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const messages: string[] = [];
  const commits = record.commits;
  if (Array.isArray(commits)) {
    for (const commit of commits) {
      if (commit && typeof commit === 'object' && typeof (commit as { message?: unknown }).message === 'string') {
        messages.push((commit as { message: string }).message);
      }
    }
  }
  const head = record.head_commit;
  if (head && typeof head === 'object' && typeof (head as { message?: unknown }).message === 'string') {
    messages.push((head as { message: string }).message);
  }
  return messages;
}

export function matchesFilter(message: string, rules: CommitFilterRule[] | undefined): CommitFilterMatch {
  if (!rules || rules.length === 0) return { matched: false };
  const normalized = message.trim().toLowerCase();
  for (const rule of rules) {
    const value = rule.value.trim().toLowerCase();
    if (value === '') continue;
    const matched = rule.mode === 'prefix' ? normalized.startsWith(value) : rule.mode === 'suffix' ? normalized.endsWith(value) : normalized.includes(value);
    if (matched) return { matched: true, rule };
  }
  return { matched: false };
}

export function isExcludedCommit(messages: string[], filter: SrcFilterConfig | undefined): CommitFilterMatch {
  const rules = filter?.commit?.exclude;
  if (!rules || rules.length === 0) return { matched: false };
  for (const message of messages) {
    const match = matchesFilter(message, rules);
    if (match.matched) return match;
  }
  return { matched: false };
}

export function parseFilterRulesFromEnv(value: string | undefined): CommitFilterRule[] {
  if (!value || value.trim() === '') return [];
  const rules: CommitFilterRule[] = [];
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    const mode = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim() as CommitFilterMode;
    const ruleValue = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    if (FILTER_MODES.includes(mode) && ruleValue !== '') rules.push({ mode, value: ruleValue });
  }
  return rules;
}
