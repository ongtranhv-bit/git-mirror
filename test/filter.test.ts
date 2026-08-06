import test from 'node:test';
import assert from 'node:assert/strict';
import { commitMessagesOf, isExcludedCommit, matchesFilter, parseFilterRulesFromEnv } from '../src/filter.js';

test('matchesFilter applies prefix, suffix and contains modes case-insensitively', () => {
  const rules = [
    { mode: 'prefix' as const, value: 'Debug' },
    { mode: 'suffix' as const, value: '[no-sync]' },
    { mode: 'contains' as const, value: 'skip-me' },
  ];
  assert.equal(matchesFilter('Debug: fix login', rules).matched, true);
  assert.equal(matchesFilter('fix login', rules).matched, false);
  assert.equal(matchesFilter('WIP [no-sync]', rules).matched, true);
  assert.equal(matchesFilter('update SKIP-ME now', rules).matched, true);
  assert.equal(matchesFilter('', rules).matched, false);
  assert.equal(matchesFilter('normal commit', undefined).matched, false);
});

test('isExcludedCommit returns the matched rule for any commit message in a push', () => {
  const filter = { commit: { exclude: [{ mode: 'prefix' as const, value: 'Debug' }] } };
  assert.equal(isExcludedCommit(['chore: cleanup', 'Debug: reproduce'], filter).matched, true);
  assert.equal(isExcludedCommit(['chore: cleanup'], filter).matched, false);
  assert.equal(isExcludedCommit(['chore: cleanup'], undefined).matched, false);
});

test('commitMessagesOf extracts messages from head_commit and commits', () => {
  const payload = {
    head_commit: { message: 'head message' },
    commits: [{ message: 'first' }, { message: 'second' }],
  };
  assert.deepEqual(commitMessagesOf(payload), ['first', 'second', 'head message']);
  assert.deepEqual(commitMessagesOf(null), []);
  assert.deepEqual(commitMessagesOf({ head_commit: null, commits: [] }), []);
});

test('parseFilterRulesFromEnv parses mode:value pairs and ignores invalid entries', () => {
  assert.deepEqual(parseFilterRulesFromEnv('prefix:Debug,suffix:[no-sync], contains:skip me'), [
    { mode: 'prefix', value: 'Debug' },
    { mode: 'suffix', value: '[no-sync]' },
    { mode: 'contains', value: 'skip me' },
  ]);
  assert.deepEqual(parseFilterRulesFromEnv('prefix:Debug,regex:abc,prefix:'), [
    { mode: 'prefix', value: 'Debug' },
  ]);
  assert.deepEqual(parseFilterRulesFromEnv(''), []);
  assert.deepEqual(parseFilterRulesFromEnv(undefined), []);
});
