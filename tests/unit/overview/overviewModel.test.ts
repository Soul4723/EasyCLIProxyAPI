import { expect, test } from 'bun:test';
import { dayBucket, groupByDay, summarizeProviders, buildNeedsAction } from '../../../src/sections/overview/model';

const NOW = new Date('2026-10-18T10:00:00').getTime();

test('groupByDay buckets today/tomorrow/later', () => {
  const h = 3_600_000;
  expect(dayBucket(NOW + h, NOW)).toBe('today');
  expect(dayBucket(NOW + 20 * h, NOW)).toBe('tomorrow');
  expect(dayBucket(NOW + 80 * h, NOW)).toBe('later');
  expect(groupByDay([{ at: NOW + h }, { at: NOW + 80 * h }], NOW).map((g) => g.bucket)).toEqual(['today', 'later']);
});

test('needs-action prefers expired over exhausted and skips disabled', () => {
  const files = [
    { name: 'a.json', provider: 'claude', auth_index: '1', status: 'error', status_message: 'token expired' },
    { name: 'b.json', provider: 'codex', auth_index: '2', disabled: true, status: 'error' },
  ];
  const rows = buildNeedsAction(files, {}, [], NOW);
  expect(rows.map((r) => r.kind)).toEqual(['expired']);
  expect(rows[0].to.page).toBe('providers');
});

test('provider summary averages fetched accounts only', () => {
  const files = [{ name: 'a.json', provider: 'codex', auth_index: '1' }, { name: 'b.json', provider: 'codex', auth_index: '2' }];
  expect(summarizeProviders(files, {})[0].leftPct).toBeNull();
});
