import type { QuotaDisplayProvider, QuotaState } from './quotaService';

/**
 * Rough card height in row units, from the data the card shows rather than its measured size, so cards keep their column when a refresh changes their height.
 * `glance` estimates the Compact summary, which shows only the name, group names and one line per quota.
 */
export function estimateQuotaCardHeight(quota: QuotaState, provider: QuotaDisplayProvider | null | undefined, glance = false): number {
  if (glance) {
    if (quota.status !== 'success') return 2.5;
    let group: string | undefined;
    let height = 1.5;
    for (const row of quota.rows) {
      if (row.groupLabel && row.groupLabel !== group) height += 1;
      group = row.groupLabel;
      height += 1;
    }
    return height;
  }
  let height = 3;
  if (quota.plan || quota.subscriptionActiveUntil) height += 1;
  if (quota.status !== 'success') return height + (quota.status === 'error' ? 2 : 1);
  if (provider === 'codex' || provider === 'claude') height += 2;
  let group: string | undefined;
  for (const row of quota.rows) {
    if (row.groupLabel && row.groupLabel !== group) height += row.groupDescription ? 2.5 : 1.5;
    group = row.groupLabel;
    height += 1.5;
  }
  return height;
}

/** Places each item, in order, into the column with the least estimated height so far; ties go to the leftmost column. */
export function stackQuotaColumns(heights: readonly number[], columnCount: number): number[][] {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => ({ height: 0, items: [] as number[] }));
  heights.forEach((height, index) => {
    const target = columns.reduce((lowest, column) => column.height < lowest.height ? column : lowest);
    target.items.push(index);
    target.height += height;
  });
  return columns.map((column) => column.items);
}

export type QuotaPlanTier = 'free' | '3' | '10' | '20' | '30' | '50' | '80' | '100' | 'top' | 'unknown';

const words = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const titleCase = (value: string) => value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

/** Plan name for the badge: without the provider's own name ("Kimi Code Pro" becomes "Pro"), the xAI paid API as "API", and Codex Pro tiers named by price like the web panel. */
export function quotaPlanLabel(provider: QuotaDisplayProvider | null | undefined, plan: string): string {
  const stripped = plan.trim().replace(/^(kimi code|kimi|devin|grok|google ai|claude|chatgpt)\s+/i, '');
  const value = words(stripped);
  if (provider === 'xai' && value === 'paid') return 'API';
  if (provider === 'codex') {
    const codex: Record<string, string> = { pro: 'Pro 200', prolite: 'Pro 100', 'pro lite': 'Pro 100', promax: 'Pro 500', 'pro max': 'Pro 500', 'self serve business prolite': 'Business' };
    if (codex[value]) return codex[value];
  }
  return stripped === stripped.toLowerCase() ? titleCase(stripped.replace(/[_-]+/g, ' ')) : stripped;
}

/**
 * Monthly USD list price (billed monthly) by provider and plan label, checked 2026-11-02 on the providers' pages:
 * claude.com/pricing, kimi.ai/help/membership/membership-pricing, devin.ai/desktop, x.ai/pricing.
 * OpenAI and Google pages could not be read directly; their US prices come from a research pass and match the Australian prices
 * the owner read off the pages on 2026-11-02 at about A$1.50 per US$1 (ChatGPT Free A$0, Go A$13, Plus A$30, Pro from A$155 with
 * 100/200/500 tiers; Google AI Plus A$7.99, Ultra from A$149.99). Google AI Plus has no US price here: A$7.99 is about US$5.
 * Team plans use the standard seat. "api" is the xAI paid API. Unknown plans return undefined.
 */
const planPrices: Partial<Record<QuotaDisplayProvider, Record<string, number | 'api'>>> = {
  codex: { free: 0, go: 8, plus: 20, 'pro 100': 100, 'pro 200': 200, 'pro 500': 500, team: 25, business: 25 },
  claude: { free: 0, pro: 20, max: 100, 'max 5x': 100, 'max 20x': 200, ultra: 200, team: 25 },
  antigravity: { free: 0, plus: 5, pro: 19.99, ultra: 99.99 },
  // Kimi's old level names map to the current plans in order: Moderato = Plus, Allegretto = Pro, Allegro = Max, Vivace = Ultra.
  kimi: { free: 0, plus: 19, moderato: 19, pro: 39, allegretto: 39, max: 99, allegro: 99, ultra: 199, vivace: 199 },
  xai: { free: 0, plus: 8, premium: 30, supergrok: 30, super: 100, ultra: 200, 'supergrok heavy': 300, api: 'api' },
  devin: { free: 0, pro: 20, max: 200, teams: 80 },
  meta: { free: 0 },
};

const priceSteps = [0, 3, 10, 20, 30, 50, 80, 100, 200, 500] as const;

/** Price tier for the plan badge: the price rounds to the nearest step (ties go up); $200, $500 and the paid API share the top tier. */
export function quotaPlanTier(provider: QuotaDisplayProvider | null | undefined, plan: string | undefined): QuotaPlanTier {
  if (!plan?.trim()) return 'unknown';
  const price = provider ? planPrices[provider]?.[words(quotaPlanLabel(provider, plan))] : undefined;
  if (price === undefined) return 'unknown';
  if (price === 'api') return 'top';
  const step = priceSteps.reduce((best, candidate) => Math.abs(candidate - price) <= Math.abs(best - price) ? candidate : best);
  if (step >= 200) return 'top';
  return step === 0 ? 'free' : String(step) as QuotaPlanTier;
}
