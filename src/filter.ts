import type { FilterMode, FilterRule, SrcFilterConfig } from './types.js';

const FILTER_MODES: FilterMode[] = ['prefix', 'suffix', 'contains'];

export interface FilterMatch {
  matched: boolean;
  rule?: FilterRule;
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

export function matchesFilter(value: string, rules: FilterRule[] | undefined): FilterMatch {
  if (!rules || rules.length === 0) return { matched: false };
  const normalized = value.trim().toLowerCase();
  for (const rule of rules) {
    const ruleValue = rule.value.trim().toLowerCase();
    if (ruleValue === '') continue;
    const matched = rule.mode === 'prefix' ? normalized.startsWith(ruleValue) : rule.mode === 'suffix' ? normalized.endsWith(ruleValue) : normalized.includes(ruleValue);
    if (matched) return { matched: true, rule };
  }
  return { matched: false };
}

export function isExcludedRepo(repoName: string, filter: SrcFilterConfig | undefined): FilterMatch {
  const rules = filter?.repo?.exclude;
  return matchesFilter(repoName, rules);
}

export function isExcludedCommit(messages: string[], filter: SrcFilterConfig | undefined): FilterMatch {
  const rules = filter?.commit?.exclude;
  if (!rules || rules.length === 0) return { matched: false };
  for (const message of messages) {
    const match = matchesFilter(message, rules);
    if (match.matched) return match;
  }
  return { matched: false };
}

export function parseFilterRulesFromEnv(value: string | undefined): FilterRule[] {
  if (!value || value.trim() === '') return [];
  const rules: FilterRule[] = [];
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    const mode = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim() as FilterMode;
    const ruleValue = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    if (FILTER_MODES.includes(mode) && ruleValue !== '') rules.push({ mode, value: ruleValue });
  }
  return rules;
}
