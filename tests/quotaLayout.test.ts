import { expect, test } from 'bun:test';
import { quotaPlanTier, stackQuotaColumns } from '../src/services/quotaLayout';

test('stacked layout puts each card in the shortest column, keeping order within columns', () => {
  // Worked by hand: 10 -> col 0; 2, 2, 2 -> col 1 (2, 4, 6); 8 -> col 1 (6 < 10, now 14); 1 -> col 0 (10 < 14).
  expect(stackQuotaColumns([10, 2, 2, 2, 8, 1], 2)).toEqual([[0, 5], [1, 2, 3, 4]]);
  // Equal heights fill left to right, like the grid.
  expect(stackQuotaColumns([1, 1, 1, 1, 1], 3)).toEqual([[0, 3], [1, 4], [2]]);
  expect(stackQuotaColumns([3, 1], 0)).toEqual([[0, 1]]);
});

test('plan tiers follow the Management Center web panel table', () => {
  // Expected tiers come from the web panel's documented table (src/features/quota/cardTier.ts at f154fa93).
  const cases: [Parameters<typeof quotaPlanTier>[0], string, string][] = [
    ['codex', 'promax', 'flagship'], ['codex', 'pro', 'premium'], ['codex', 'prolite', 'premium'], ['codex', 'plus', 'standard'], ['codex', 'team', 'standard'],
    ['claude', 'Max 20x', 'flagship'], ['claude', 'Max', 'premium'], ['claude', 'Max 5x', 'premium'], ['claude', 'Pro', 'standard'], ['claude', 'Free', 'standard'],
    ['antigravity', 'Ultra', 'flagship'], ['antigravity', 'Ultra Lite', 'premium'], ['antigravity', 'Pro', 'standard'],
    ['kimi', 'Allegro', 'flagship'], ['kimi', 'Allegretto', 'premium'], ['kimi', 'Moderato', 'standard'],
    ['xai', 'SuperGrok Heavy', 'flagship'], ['xai', 'SuperGrok', 'premium'], ['xai', 'Paid', 'premium'], ['xai', 'Free', 'standard'],
    ['devin', 'Devin Pro', 'standard'], ['codex', '', 'standard'],
  ];
  for (const [provider, plan, tier] of cases) expect([provider, plan, quotaPlanTier(provider, plan)]).toEqual([provider, plan, tier]);
});
