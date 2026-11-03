import { expect, test } from 'bun:test';
import { estimateCredentialCardHeight, lowestQuotaRow, quotaPlanLabel, quotaPlanTier, stackQuotaColumns } from '../src/services/quotaLayout';
import type { QuotaState } from '../src/services/quotaService';
import { resolveClaudePlan } from '../src/services/quotaService';

test('stacked layout puts each card in the shortest column, keeping order within columns', () => {
  // Worked by hand: 10 -> col 0; 2, 2, 2 -> col 1 (2, 4, 6); 8 -> col 1 (6 < 10, now 14); 1 -> col 0 (10 < 14).
  expect(stackQuotaColumns([10, 2, 2, 2, 8, 1], 2)).toEqual([[0, 5], [1, 2, 3, 4]]);
  // Equal heights fill left to right, like the grid.
  expect(stackQuotaColumns([1, 1, 1, 1, 1], 3)).toEqual([[0, 3], [1, 4], [2]]);
  expect(stackQuotaColumns([3, 1], 0)).toEqual([[0, 1]]);
});

test('plan badges are named without the provider and coloured by the nearest price step', () => {
  // Prices are the providers' monthly list prices (2026-11-02), rounded by hand to the nearest of 0, 3, 10, 20, 30, 50, 80, 100, and 200 or more.
  const cases: [Parameters<typeof quotaPlanTier>[0], string, string, string][] = [
    ['codex', 'free', 'Free', 'free'], ['codex', 'go', 'Go', '10'], ['codex', 'plus', 'Plus', '20'], ['codex', 'team', 'Team', '30'],
    ['codex', 'prolite', 'Pro 100', '100'], ['codex', 'pro', 'Pro 200', 'top'], ['codex', 'promax', 'Pro 500', 'top'],
    ['claude', 'Pro', 'Pro', '20'], ['claude', 'Max', 'Max', '100'], ['claude', 'Ultra', 'Ultra', 'top'], ['codex', 'self_serve_business_prolite', 'Business Premium', '100'], ['claude', 'Team', 'Team', '30'],
    ['antigravity', 'Plus', 'Plus', '3'], ['antigravity', 'Google AI Plus', 'Plus', '3'], ['antigravity', 'Pro', 'Pro', '20'], ['antigravity', 'Ultra', 'Ultra', '100'], ['antigravity', 'Ultra Lite', 'Ultra Lite', 'unknown'],
    ['kimi', 'Kimi Code Pro', 'Pro', '30'], ['kimi', 'Moderato', 'Moderato', '20'], ['kimi', 'Allegro', 'Allegro', '100'], ['kimi', 'Vivace', 'Vivace', 'top'],
    ['xai', 'Paid', 'API', 'top'], ['xai', 'SuperGrok', 'SuperGrok', '30'], ['xai', 'SuperGrok Heavy', 'SuperGrok Heavy', 'top'], ['xai', 'Plus', 'Plus', '10'],
    ['devin', 'Devin Pro', 'Pro', '20'], ['devin', 'Teams', 'Teams', '80'], ['devin', 'Max', 'Max', 'top'],
    ['meta', 'Enterprise', 'Enterprise', 'unknown'], ['codex', '', '', 'unknown'],
  ];
  for (const [provider, plan, label, tier] of cases) {
    expect([provider, plan, plan ? quotaPlanLabel(provider, plan) : '', quotaPlanTier(provider, plan)]).toEqual([provider, plan, label, tier]);
  }
});

test('Claude Max and Ultra are told apart by the organization rate-limit tier', () => {
  // Field names and values as documented in the Management Center web panel (providers/claude/data.ts at f154fa93).
  expect(resolveClaudePlan({ account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } })).toBe('Ultra');
  expect(resolveClaudePlan({ account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_5x' } })).toBe('Max');
  expect(resolveClaudePlan({ account: { has_claude_max: true }, organization: {} })).toBe('Max');
  expect(resolveClaudePlan({ account: { has_claude_pro: true }, organization: { rate_limit_tier: 'default_claude_ai' } })).toBe('Pro');
});

test('the credential glance line shows the quota row with the least remaining share', () => {
  const rows = [{ label: '5h', remainingPercent: 62 }, { label: 'Week', remainingPercent: null }, { label: 'Opus', remainingPercent: 18 }, { label: 'Month', remainingPercent: 40 }];
  expect(lowestQuotaRow({ status: 'success', rows } as QuotaState)?.label).toBe('Opus');
  expect(lowestQuotaRow({ status: 'success', rows: [{ label: 'Week', remainingPercent: null }] } as QuotaState)).toBeNull();
  expect(lowestQuotaRow({ status: 'loading', rows } as QuotaState)).toBeNull();
});

test('credential card heights grow with what the card shows, and glance cards are short', () => {
  const quota = (count: number) => ({ status: 'success', rows: Array.from({ length: count }, (_, index) => ({ label: String(index), remainingPercent: 50 })) }) as QuotaState;
  const base = { quota: quota(2), tags: false, cooldown: false, expanded: false, glance: false };
  // Two quota rows share a line in the dense panel: 9 + 1 line x 1.5.
  expect(estimateCredentialCardHeight(base)).toBe(10.5);
  expect(estimateCredentialCardHeight({ ...base, quota: quota(3) })).toBe(12);
  expect(estimateCredentialCardHeight({ ...base, tags: true, cooldown: true, expanded: true })).toBe(19);
  expect(estimateCredentialCardHeight({ ...base, glance: true, expanded: true })).toBe(3);
  expect(estimateCredentialCardHeight({ ...base, glance: true, tags: true })).toBe(4);
});
