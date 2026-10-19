import { describe, expect, it } from 'bun:test';
import { quotaRowsFor, formatQuotaTimestamp } from '../../../src/services/quotaService';
import type { QuotaState } from '../../../src/services/quotaService';
import { renderCard } from '../../helpers/quotaAccount';

type CardFile = Parameters<typeof renderCard>[0];

const render = (quota: QuotaState, provider = 'codex') => renderCard({ name: 'test.json', provider } as CardFile, quota);

const bankedButton = (html: string) => html.match(/<button[^>]*qt-banked[^>]*>/)?.[0] ?? '';
const cardStatus = (html: string) => html.match(/data-status="([^"]+)"/)?.[1] ?? '';

describe('quota card rendering', () => {
  it('当前适用次数为零时仍可重置，并保留额度详情', () => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2, resetCreditsApplicable: 0,
      resetCreditsError: 'temporary failure', subscriptionActiveUntil: '2030-01-01T00:00:00Z',
    });
    expect(bankedButton(html)).not.toBe('');
    expect(bankedButton(html)).not.toContain('disabled=""');
    expect(html).not.toContain('temporary failure');
    expect(bankedButton(html)).toContain('2 banked resets');
  });

  it.each(['error', 'refresh-error'] as const)('重置结果为 %s 时仍可再次点击重置', (status) => {
    const html = render({
      status: 'success', rows: [], resetCredits: 2,
      actionResult: { action: 'reset', status, error: 'temporary failure' },
    });
    expect(bankedButton(html)).not.toBe('');
    expect(bankedButton(html)).not.toContain('disabled=""');
    expect(html).not.toContain('temporary failure');
  });

  it('xAI 付费账号保留额度说明和刷新入口，不显示可用性测试', () => {
    const html = render({ status: 'success', rows: [{ label: 'Paid API account', remainingPercent: null, detail: 'Upstream did not provide remaining quota' }] }, 'xai');
    expect(html).toContain('Upstream did not provide remaining quota');
    expect(html).not.toMatch(/width:\d+%/);
    expect(html).not.toContain('Test availability');
    expect(html).toContain('aria-label="Refresh quota"');
  });

  it('xAI 探测成功显示可用说明，100% 额度保留刷新按钮', () => {
    const healthy = render({
      status: 'success', rows: quotaRowsFor('xai', { mode: 'paid-health' }),
    }, 'xai');
    expect(healthy).toContain('Paid API chat is available');
    expect(healthy).not.toMatch(/width:\d+%/);
    const full = render({
      status: 'success', rows: quotaRowsFor('xai', { config: { creditUsagePercent: 0 } }),
    }, 'xai');
    expect(full).toMatch(/qt-win__pct[^>]*>100%</);
    expect(full).toContain('width:100%');
    expect(full).not.toContain('disabled=""');
  });

  it('Grok 套餐、未知周额度和预付余额可通过现有卡片完整显示', () => {
    const html = render({ status: 'success', plan: 'SuperGrok Heavy', rows: quotaRowsFor('xai', {
      weekly: { config: { currentPeriod: { type: 'weekly', end: '2030-01-08T00:00:00Z' }, prepaidBalance: 250 } },
      monthly: { config: { monthlyLimit: 10000, used: 2500 } },
    }) }, 'xai');
    expect(html).toContain('SuperGrok Heavy');
    expect(html).toContain('Weekly quota');
    expect(html).toContain('Prepaid balance');
    expect(html).toContain('$2.50');
    expect(html.match(/qt-win__pct[^>]*>75%</g)).toHaveLength(1);
    expect(html.match(/width:\d+%/g)).toHaveLength(1);
  });

  it('缓存中的原始重置时间提供动态提示，过期额度不伪造为已恢复', () => {
    const html = render({ status: 'success', rows: [{ label: '5h', remainingPercent: 0, resetAtMs: Date.parse('2020-01-01T00:00:00Z') }] });
    expect(html).toContain('qt-reset--passed');
    expect(html).toMatch(/qt-win__pct[^>]*>0%</);
    expect(html).not.toMatch(/qt-win__pct[^>]*>100%</);
  });

  it('Kimi 免费账号取不到额度时只显示卡片内失败状态', () => {
    const html = render({ status: 'error', rows: [], error: 'free account cannot access quota' }, 'kimi');
    expect(html).toContain('qt-empty__err');
    expect(html).toContain('free account cannot access quota');
  });
});


it('renders unavailable measurements instead of fabricated percentages on the quota page', () => {
  // The card shows at most 3 windows (MAX_CARD_WINDOWS), so each case must fit in the first 3 rows.
  const valid = render({ status: 'success', rows: [
    { label: 'Exhausted', remainingPercent: 0 },
    { label: 'Known', remainingPercent: 75 },
    { label: 'Unknown', remainingPercent: null },
  ] });
  expect(valid.match(/width:\d+%/g)).toHaveLength(2);
  expect(valid).toMatch(/qt-win__pct[^>]*>0%</);
  expect(valid).toMatch(/qt-win__pct[^>]*>75%</);
  expect(valid.match(/qt-win__pct[^>]*>—</g)).toHaveLength(1);

  const malformed = render({ status: 'success', rows: [
    { label: 'Malformed low', remainingPercent: -20 },
    { label: 'Malformed high', remainingPercent: 140 },
    { label: 'Not a number', remainingPercent: NaN },
  ] });
  expect(malformed.match(/qt-win__pct[^>]*>—</g)).toHaveLength(3);
  expect(malformed).not.toContain('140%');
  expect(malformed).not.toContain('-20%');
  expect(malformed).not.toContain('NaN');

  const infinite = render({ status: 'success', rows: [{ label: 'Infinite', remainingPercent: Infinity }] });
  expect(infinite.match(/qt-win__pct[^>]*>—</g)).toHaveLength(1);
  expect(infinite).not.toContain('Infinity');
});


describe('quota card uses credential health, not fetch success, for account status', () => {
  const renderFile = (file: Record<string, unknown>, quota: QuotaState) => renderCard(
    { name: 'health.json', provider: 'codex', ...file } as CardFile,
    quota,
  );

  it('keeps active credential status while quota reads fail or load', () => {
    for (const status of ['idle', 'loading', 'success'] as const) {
      const html = renderFile({ status: 'active' }, { status, rows: [] });
      expect(cardStatus(html)).not.toBe('error');
      expect(cardStatus(html)).not.toBe('disabled');
    }
    const failed = renderFile({ status: 'active' }, { status: 'error', rows: [], error: 'Quota read failed' });
    expect(cardStatus(failed)).toBe('error');
    expect(failed).toContain('Quota read failed');
  });

  it('does not make unknown or rejected credentials healthy from successful quota data', () => {
    const quota: QuotaState = { status: 'success', rows: [{ label: '5h', remainingPercent: 100 }] };
    const unknown = renderFile({}, quota);
    expect(cardStatus(unknown)).not.toBe('expired');
    const rejected = renderFile({ status: 'error', status_message: 'token expired' }, quota);
    expect(cardStatus(rejected)).toBe('expired');
    expect(rejected).toContain('Credential expired');
  });

  it('honors a core disabled status even without the boolean disabled field', () => {
    const html = renderFile({ status: 'disabled' }, { status: 'success', rows: [], resetCredits: 2 });
    expect(cardStatus(html)).toBe('disabled');
    expect(html).toContain('is-disabled');
  });
});
