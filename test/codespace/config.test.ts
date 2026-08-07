import test from 'node:test';
import assert from 'node:assert/strict';
import { dateForRotationKey, loadRotationConfig, resolveRotationDay } from '../../src/codespace/config.js';

const raw = JSON.stringify({
  configVersion: 1,
  enabled: true,
  timezone: 'Asia/Ho_Chi_Minh',
  startAt: '23:00',
  days: {
    '7': { enabled: true, codespaceAccount: { expectedLogin: 'user07', tokenEnv: 'TOKEN_07' } },
  },
  bootstrap: { owner: 'org', repo: 'runner', branch: 'main' },
  runtime: { stabilizationSeconds: 0, stopOldAfterHealthy: false },
  testing: { enabled: false },
});

test('rotation config is separate and resolves timezone day', async () => {
  const config = await loadRotationConfig({ raw });
  const resolved = resolveRotationDay(config, new Date('2026-08-06T18:00:00Z'));
  assert.deepEqual(resolved, { dayOfMonth: 7, rotationKey: '2026-08-07' });
  assert.equal(config.runtime.deleteOldAfterStop, false);
});

test('production rejects test mode without emergency override', async () => {
  const testing = JSON.stringify({ ...JSON.parse(raw), testing: { enabled: true, tokenDay: 7 } });
  await assert.rejects(() => loadRotationConfig({ raw: testing, env: { NODE_ENV: 'production' } }), /production rejects testing mode/);
});

test('explicit rotation date preserves calendar key in extreme timezones and rejects invalid dates', async () => {
  const base = JSON.parse(raw);
  base.timezone = 'Pacific/Kiritimati';
  const config = await loadRotationConfig({ raw: JSON.stringify(base) });
  const date = dateForRotationKey(config, '2026-08-07');
  assert.equal(resolveRotationDay(config, date).rotationKey, '2026-08-07');
  assert.throws(() => dateForRotationKey(config, '2026-02-30'), /not a valid calendar date/);
});

test('rotation config rejects Codespace retention beyond GitHub maximum', async () => {
  const invalid = JSON.parse(raw);
  invalid.bootstrap.retentionPeriodDays = 31;
  await assert.rejects(
    () => loadRotationConfig({ raw: JSON.stringify(invalid) }),
    /retentionPeriodDays: must be between 1 and 30 days/,
  );
});
