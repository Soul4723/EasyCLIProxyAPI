import { describe, expect, it } from 'bun:test';
import { classifyWindow, deriveStatus, groupAccounts, matchesSearch } from '../../../src/sections/quota/model';
import { accountFor, renderCard, renderRow, stubLighting } from '../../helpers/quotaAccount';
import type { QuotaState } from '../../../src/services/quotaService';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const ok = (rows: QuotaState['rows'], extra: Partial<QuotaState> = {}): QuotaState => ({ status: 'success', rows, fetchedAt: NOW - 60_000, ...extra });

describe('quota section model', () => {
  it('classifies windows by label and falls back to the reset horizon', () => {
    expect(classifyWindow({ label: '5-hour window', remainingPercent: 50 }, NOW, 'en').kind).toBe('5h');
    expect(classifyWindow({ label: '7-day window', remainingPercent: 50 }, NOW, 'en').kind).toBe('weekly');
    expect(classifyWindow({ label: 'Gemini Models Five Hour Limit', remainingPercent: 50 }, NOW, 'en').kind).toBe('5h');
    expect(classifyWindow({ label: 'Mystery', remainingPercent: 50, resetAtMs: NOW + 3 * 3_600_000 }, NOW, 'en').kind).toBe('5h');
    expect(classifyWindow({ label: 'Mystery', remainingPercent: 50, resetAtMs: NOW + 3 * 86_400_000 }, NOW, 'en').kind).toBe('weekly');
    expect(classifyWindow({ label: 'Mystery', remainingPercent: 50 }, NOW, 'en').kind).toBe('other');
  });

  it('derives one status from health, cooldown and windows', () => {
    const base = { disabled: false, healthTone: 'success' as const, healthMessage: '', cooldownActive: false };
    const win = (leftPct: number | null) => ({ id: 'x', kind: '5h' as const, rawLabel: '5h', prefix: '', leftPct });
    expect(deriveStatus({ ...base, disabled: true, quota: ok([]), windows: [] }).status).toBe('disabled');
    expect(deriveStatus({ ...base, healthTone: 'error', healthMessage: 'Token expired', quota: ok([]), windows: [] }).status).toBe('expired');
    expect(deriveStatus({ ...base, cooldownActive: true, quota: ok([]), windows: [win(80)] }).status).toBe('cooldown');
    expect(deriveStatus({ ...base, healthTone: 'error', healthMessage: 'boom', quota: ok([]), windows: [] }).status).toBe('error');
    expect(deriveStatus({ ...base, quota: { status: 'idle', rows: [] }, windows: [] }).status).toBe('notFetched');
    expect(deriveStatus({ ...base, quota: ok([]), windows: [win(0)] }).status).toBe('exhausted');
    expect(deriveStatus({ ...base, quota: ok([]), windows: [win(12)] }).status).toBe('limited');
    expect(deriveStatus({ ...base, quota: ok([]), windows: [win(80)] }).status).toBe('available');
  });

  it('builds provider groups with a mean of the per-account bottleneck', () => {
    const rows = (a: number, b: number) => ok([
      { label: '5-hour window', remainingPercent: a, resetAtMs: NOW + 3_600_000 },
      { label: '7-day window', remainingPercent: b, resetAtMs: NOW + 86_400_000 },
    ]);
    const accounts = [
      accountFor({ name: 'a.json', provider: 'claude', email: 'a@example.test' }, rows(80, 40)),
      accountFor({ name: 'b.json', provider: 'claude', email: 'b@example.test' }, rows(20, 90)),
      accountFor({ name: 'c.json', provider: 'claude', email: 'c@example.test', disabled: true }, rows(5, 5)),
      accountFor({ name: 'd.json', provider: 'codex' }, { status: 'idle', rows: [] }),
    ];
    const groups = groupAccounts(accounts);
    expect(groups.map((group) => group.provider)).toEqual(['claude', 'codex']);
    expect(groups[0].leftPct).toBe(30);
    expect([groups[0].enabled, groups[0].total]).toEqual([2, 3]);
    expect(groups[1].leftPct).toBeNull();
    expect(groups[0].nextResetMs).toBe(NOW + 3_600_000);
  });

  it('searches file name, email, plan and provider', () => {
    const account = accountFor({ name: 'work.json', provider: 'codex', email: 'pat@example.test', plan_type: 'team' }, ok([]));
    expect(matchesSearch(account, 'PAT@')).toBe(true);
    expect(matchesSearch(account, 'team')).toBe(true);
    expect(matchesSearch(account, 'claude')).toBe(false);
  });
});

describe('quota account card and row', () => {
  const rows = [
    { label: '5-hour window', remainingPercent: 62, resetAtMs: NOW + 3_600_000 },
    { label: '7-day window', remainingPercent: 41, resetAtMs: NOW + 3 * 86_400_000 },
  ];
  it('renders windows, status and the banked-reset badge for Codex', () => {
    const html = renderCard({ name: 'codex.json', provider: 'codex' }, ok(rows, { resetCredits: 2, resetCreditsApplicable: 2 }));
    expect(html).toContain('62%');
    expect(html).toContain('41%');
    expect(html).toContain('Available');
    expect(html).toContain('qt-banked');
  });
  it('shows a fetch action for accounts that were never fetched and no windows', () => {
    const html = renderCard({ name: 'codex.json', provider: 'codex' }, { status: 'idle', rows: [] });
    expect(html).toContain('Not fetched');
    expect(html).toContain('Fetch');
  });
  it('flags expired credentials with a link to Providers', () => {
    const html = renderCard({ name: 'old.json', provider: 'claude', status: 'error', status_message: 'token expired' }, { status: 'idle', rows: [] });
    expect(html).toContain('Expired');
    expect(html).toContain('#/providers');
  });
  it('disables the lighting button with a reason for unsupported providers', () => {
    const html = renderCard({ name: 'k.json', provider: 'kimi' }, ok(rows), {
      ctx: { lighting: stubLighting({ capabilityFor: () => ({ provider: 'kimi', supported: false, defaultModel: null, allowedWindows: [], reason: 'x' }) }) },
    });
    expect(html).toContain('Lighting is not supported for this provider yet');
  });
  it('renders the compact row with fixed 5h and week columns', () => {
    const html = renderRow({ name: 'codex.json', provider: 'codex' }, ok(rows));
    expect(html).toContain('qt-row');
    expect(html.match(/qt-rowmeter/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('lighting observed reset', () => {
  const schedule = (over: Partial<import('../../../src/services/lighting').LightingSchedule> = {}) => ({
    id: 'x', credential: { provider: 'codex', authFileName: 'a.json', authIndex: 'i' }, target: 't', enabled: true, mode: 'after_reset',
    times: [], weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: 'UTC', windowKind: '5h', model: null, activeHours: null,
    retry: { maxAttempts: 3, intervalSeconds: 60, backoff: 2, circuitSeconds: 900 }, lastRun: null, nextRun: null,
    observedReset: null, consumedReset: null, attempt: 0, circuitUntil: null, ...over,
  }) as import('../../../src/services/lighting').LightingSchedule;
  const quota = ok([
    { label: '5-hour window', remainingPercent: 40, resetAtMs: NOW + 3_600_000 },
    { label: '7-day window', remainingPercent: 70, resetAtMs: NOW + 86_400_000 },
  ]);
  it('picks the schedule window reset from a fetched snapshot', async () => {
    const { observedResetFor } = await import('../../../src/sections/quota/useLighting');
    expect(observedResetFor(schedule(), quota, NOW, 'en')).toBe(NOW + 3_600_000);
    expect(observedResetFor(schedule({ windowKind: 'weekly' }), quota, NOW, 'en')).toBe(NOW + 86_400_000);
  });
  it('ignores drift under two minutes, unfetched data and windows that have not started', async () => {
    const { observedResetFor } = await import('../../../src/sections/quota/useLighting');
    expect(observedResetFor(schedule({ observedReset: NOW + 3_600_000 + 30_000 }), quota, NOW, 'en')).toBeUndefined();
    expect(observedResetFor(schedule(), { status: 'idle', rows: [] }, NOW, 'en')).toBeUndefined();
    const full = ok([{ label: '5-hour window', remainingPercent: 100, resetAtMs: NOW + 3_600_000 }]);
    expect(observedResetFor(schedule(), full, NOW, 'en')).toBeUndefined();
  });
});
