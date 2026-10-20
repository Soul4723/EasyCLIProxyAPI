import { describe, expect, it } from 'bun:test';
import { sameItemProps } from '../../../src/sections/quota/AccountItem';
import { sortAccounts, stabilizeAccounts } from '../../../src/sections/quota/model';
import type { QuotaState } from '../../../src/services/quotaService';
import { NOW, accountFor, context } from '../../helpers/quotaAccount';

const TICK = 30_000;
const ok = (rows: QuotaState['rows'], extra: Partial<QuotaState> = {}): QuotaState => ({ status: 'success', rows, fetchedAt: NOW - 60_000, ...extra });
const windowRows = (resetAtMs: number, left = 60) => [{ label: '5-hour window', remainingPercent: left, resetAtMs }];
const fileA = { name: 'a.json', provider: 'claude', email: 'a@example.test' };
const fileB = { name: 'b.json', provider: 'codex', email: 'b@example.test' };

describe('quota list identity', () => {
  const quotaA = ok(windowRows(NOW + 3_600_000));
  const quotaB = ok(windowRows(NOW + 7_200_000, 90));
  const build = (now: number, quotas = { a: quotaA, b: quotaB }) =>
    sortAccounts([accountFor(fileA, quotas.a, now), accountFor(fileB, quotas.b, now)]);

  it('keeps the account objects and the array across a tick that changes nothing', () => {
    const first = build(NOW);
    const second = stabilizeAccounts(first, build(NOW + TICK));
    expect(second).toBe(first);
  });

  it('replaces only the account whose data changed', () => {
    const first = build(NOW);
    const refreshed = ok(windowRows(NOW + 3_600_000, 10), { fetchedAt: NOW });
    const second = stabilizeAccounts(first, build(NOW + TICK, { a: refreshed, b: quotaB }));
    expect(second).not.toBe(first);
    const [a, b] = second;
    expect(a).not.toBe(first[0]);
    expect(a.effectiveLeftPct).toBe(10);
    expect(b).toBe(first[1]);
  });

  it('replaces an account whose time-derived fields move with the clock', () => {
    const first = build(NOW);
    // The 30 minute stale threshold is crossed for both accounts (fetched 1 minute before NOW).
    const second = stabilizeAccounts(first, build(NOW + 31 * 60_000));
    expect(first.every((account) => !account.stale)).toBe(true);
    expect(second.every((account) => account.stale)).toBe(true);
    second.forEach((account, index) => expect(account).not.toBe(first[index]));
  });

  it('follows the new order and drops removed accounts', () => {
    const first = build(NOW);
    const only = stabilizeAccounts(first, [accountFor(fileB, quotaB, NOW + TICK)]);
    expect(only).toHaveLength(1);
    expect(only[0]).toBe(first[1]);
  });
});

describe('quota card memo comparison', () => {
  const account = accountFor(fileA, ok(windowRows(NOW + 45_000)));
  const props = (overrides: Partial<Parameters<typeof sameItemProps>[0]> = {}) => ({
    account, ctx: context(), selected: false, grouped: true, ...overrides,
  });

  it('skips a tick that crosses no time boundary and a new ctx object with the same parts', () => {
    const base = props();
    expect(sameItemProps(base, props({ ctx: { ...base.ctx } }))).toBe(true);
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, now: NOW + 10_000 } }))).toBe(true);
  });

  it('renders when a reset time passes, so the countdown flips to "reset"', () => {
    const base = props();
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, now: NOW + TICK + 30_000 } }))).toBe(false);
  });

  it('renders for a new account, selection change, lighting or actions', () => {
    const base = props();
    const other = accountFor(fileA, ok(windowRows(NOW + 45_000, 5)));
    expect(sameItemProps(base, props({ account: other }))).toBe(false);
    expect(sameItemProps(base, props({ selected: true }))).toBe(false);
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, lighting: context().lighting } }))).toBe(false);
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, actions: context().actions } }))).toBe(false);
  });

  it('renders only for the busy flag of its own account', () => {
    const base = props();
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, busyKeys: new Set(['someone-else']) } }))).toBe(true);
    expect(sameItemProps(base, props({ ctx: { ...base.ctx, busyKeys: new Set([account.key]) } }))).toBe(false);
  });
});
