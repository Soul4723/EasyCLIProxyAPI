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
