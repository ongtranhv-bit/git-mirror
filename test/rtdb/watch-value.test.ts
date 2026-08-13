import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRtdbClient } from '../../src/rtdb/memory-client.js';
import { createLogger } from '../../src/shared/logger.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('memory client watchValue emits initial value and subsequent changes', async () => {
  const client = new MemoryRtdbClient();
  const received: Array<string | null> = [];
  const off = client.watchValue<string>('/sync/config', (value) => { received.push(value); });

  await client.set('/sync/config', 'first');
  await client.set('/sync/config', 'second');
  await client.remove('/sync/config');

  assert.deepEqual(received, [null, 'first', 'second', null]);
  off();
  await client.set('/sync/config', 'third');
  assert.equal(received.at(-1), null);
});

test('memory client watchValue on a parent fires when a descendant changes', async () => {
  const client = new MemoryRtdbClient();
  const received: Array<unknown> = [];
  const off = client.watchValue<Record<string, { ownerId: string }>>('/sync/runners', (value) => { received.push(value); });

  await client.set('/sync/runners/github', { ownerId: 'a', generation: 1 });
  await client.set('/sync/runners/github', { ownerId: 'b', generation: 2 });

  assert.equal(received.length, 3);
  assert.equal((received.at(-1) as Record<string, { ownerId: string }>).github?.ownerId, 'b');
  off();
});
