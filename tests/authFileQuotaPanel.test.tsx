import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthFileQuotaPanel } from '../src/components/AuthFileQuotaPanel';
import { I18nProvider } from '../src/i18n';
import { quotaResetExpiries, type QuotaState } from '../src/services/quotaService';
import { accountFor, renderCard } from './helpers/quotaAccount';

const render = (quota: QuotaState) => renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={{ name: 'test.json' }} quota={quota} disabled={false} onRefresh={() => {}} /></I18nProvider>);

it('shows every reset expiry in chronological order, including duplicates, on the panel', () => {
  const quota: QuotaState = {
    status: 'success', rows: [], resetCredits: 3,
    resetCreditExpiries: ['2030-12-20T00:00:00Z', '2030-10-10T00:00:00Z', '2030-10-10T00:00:00Z'],
  };
  const file = { name: 'codex.json', provider: 'codex' };
  const html = renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota} disabled={false} compact dense onRefresh={() => {}} /></I18nProvider>);
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain('Reset 3 expires');
  expect(html).not.toContain('Earliest expiry');
  expect(html.indexOf('10/10/2030')).toBeLessThan(html.indexOf('12/20/2030'));
  expect(quotaResetExpiries(quota)).toEqual(['2030-10-10T00:00:00Z', '2030-10-10T00:00:00Z', '2030-12-20T00:00:00Z']);
});

it('normalizes the OAuth credential priority on the account model', () => {
  expect(accountFor({ name: 'priority.json', provider: 'codex', priority: 7 }, { status: 'success', rows: [] }).priority).toBe(7);
});

it('normalizes a string priority and keeps zero as the default', () => {
  expect(accountFor({ name: 'priority.json', provider: 'codex', priority: '3' }, { status: 'idle', rows: [] }).priority).toBe(3);
  expect(accountFor({ name: 'default.json', provider: 'codex' }, { status: 'idle', rows: [] }).priority).toBe(0);
});

it('renders measured quota values and keeps malformed readings unavailable, distinct from zero', () => {
  const html = render({ status: 'success', rows: [
    { label: 'empty', remainingPercent: 0 }, { label: 'full', remainingPercent: 100 },
    { label: 'too high', remainingPercent: 140 }, { label: 'too low', remainingPercent: -20 },
    { label: 'unknown', remainingPercent: null }, { label: 'invalid', remainingPercent: NaN },
  ] });
  expect(html.match(/role="progressbar"/g)).toHaveLength(2);
  expect(html.match(/aria-valuenow="0"/g)).toHaveLength(1);
  expect(html.match(/aria-valuenow="100"/g)).toHaveLength(1);
  expect(html.match(/credential-quota-row unknown/g)).toHaveLength(4);
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('140%');
});

it('does not fabricate progress percentages while loading or on failure', () => {
  const loading = render({ status: 'loading', rows: [] });
  expect(loading).toContain('indeterminate');
  expect(loading).not.toContain('aria-valuenow');
  const error = render({ status: 'error', rows: [], error: 'upstream failed' });
  expect(error).toContain('upstream failed');
  expect(error).not.toContain('role="progressbar"');
});

it.each([
  { credits: undefined, visible: false, disabled: false },
  { credits: 0, visible: false, disabled: false },
  { credits: 2, visible: true, disabled: false },
  { credits: 2, applicable: 0, remaining: 100, visible: true, disabled: false },
  { credits: 2, loading: true, visible: true, disabled: true },
  { credits: 2, fileDisabled: true, visible: true, disabled: true },
  { credits: 2, provider: 'claude', visible: false, disabled: false },
  { credits: 2, result: 'error', visible: true, disabled: false },
  { credits: 2, result: 'refresh-error', visible: true, disabled: false },
] as const)('matches quota-page reset visibility and availability: %j', (scenario) => {
  const values = scenario as { credits?: number; applicable?: number; remaining?: number; loading?: boolean; fileDisabled?: boolean; provider?: string; result?: 'error' | 'refresh-error'; visible: boolean; disabled: boolean };
  const file = { name: 'test.json', provider: values.provider ?? 'codex', disabled: values.fileDisabled ?? false };
  const quota: QuotaState = {
    status: values.loading ? 'loading' : 'success', rows: [{ label: '5h', remainingPercent: values.remaining ?? 0 }],
    resetCredits: values.credits, resetCreditsApplicable: values.applicable,
    pendingAction: values.loading ? 'reset' : undefined,
    actionResult: values.result ? { action: 'reset', status: values.result, error: 'test error' } : undefined,
  };
  const onReset = file.provider === 'codex' ? () => {} : undefined;
  const credentialHtml = renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota} disabled={file.disabled} onRefresh={() => {}} onReset={onReset} /></I18nProvider>);
  const buttonState = (html: string) => {
    const button = html.match(/<button[^>]*title="Reset Quota"[^>]*>Reset Quota<\/button>/)?.[0];
    return { visible: Boolean(button), disabled: Boolean(button?.includes('disabled=""')) };
  };
  expect(buttonState(credentialHtml)).toEqual({ visible: values.visible, disabled: values.disabled });
  if (values.loading) expect(credentialHtml).toContain('Submitting reset and refreshing quota');
});


it('both quota surfaces gate refresh and reset on core disabled status without a boolean flag', () => {
  const file = { name: 'disabled.json', provider: 'codex', status: 'disabled' };
  const quota: QuotaState = { status: 'success', rows: [], resetCredits: 2 };
  const html = renderToStaticMarkup(<I18nProvider><AuthFileQuotaPanel file={file} quota={quota} disabled={false} onRefresh={() => {}} onReset={() => {}} /></I18nProvider>);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Reset Quota"/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="[^"]*disabled[^"]*"/i);
  const card = renderCard(file, quota);
  expect(card).toContain('is-disabled');
  expect(card).toContain('Disabled accounts cannot be refreshed');
});
