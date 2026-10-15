import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n';
import { QuotaCard } from '../../src/pages/QuotaPage';
import { parseAnthropicResetGrantStatus } from '../../src/services/claudeResetGrants';
import { AuthFileQuotaPanel } from '../../src/components/AuthFileQuotaPanel';
import { quotaRowsFor } from '../../src/services/quotaService';
import '../../src/styles/index.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'en');
const compact = new URLSearchParams(location.search).has('compact');
const rows = quotaRowsFor('kimi', {
  limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, remaining: 80 } }],
  usage: { limit: 100, remaining: 60 },
});

const claudeFile = { name: 'claude.json', provider: 'claude', auth_index: 'claude-fixture' };
const claudeQuota = { status: 'success' as const, rows, resetCredits: 2, claudeResetGrants: parseAnthropicResetGrantStatus({ eligible: true, at_limit: true, grants: [{ id: 'reserve', resets_total: 2, resets_left: 2, usable_now: true }] })! };

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <main className="content" style={{ width: 1100, padding: 0 }}>
      <section className="page quota-page">
        <div className="real-quota-grid">
          {[1, 2, 3, 4, 5, 6].map((id) => <QuotaCard compact={compact} key={id} file={{ name: `kimi-${id}-long-credential-name@example.com.json`, provider: 'kimi' }} quota={{ status: 'success', rows: compact ? [...rows, { label: 'Weekly additional window', remainingPercent: null, detail: 'Unknown quota detail', reset: 'Friday' }, { label: 'Exhausted window', remainingPercent: id === 3 ? null : 0, detail: 'Full quota diagnostic', reset: 'Monday' }, ...(id === 2 ? [{ label: 'Second exhausted window', remainingPercent: 0 }] : [])] : rows }} onRefresh={() => { document.body.dataset.refreshed = 'yes'; }} />)}
        </div>
        <div className="real-quota-grid">
          <QuotaCard compact={compact} file={{ name: 'codex.json', provider: 'codex' }} quota={{ status: 'success', rows, resetCredits: 2, resetCreditsApplicable: 2, plan: 'team', subscriptionActiveUntil: '2030-10-17T13:58:00Z', resetCreditExpiries: ['2030-10-23T05:10:00Z', '2030-11-23T05:10:00Z'] }} onRefresh={() => {}} onReset={() => { document.body.dataset.reset = 'yes'; }} />
          <QuotaCard compact={compact} file={claudeFile} quota={claudeQuota} onRefresh={() => {}} onReset={() => { document.body.dataset.reset = 'yes'; }} />
          <QuotaCard compact={compact} file={{ name: 'failed.json', provider: 'kimi' }} quota={{ status: 'error', rows: [], error: 'Quota request failed for private-account@example.com with a very long diagnostic that must wrap inside the card' }} onRefresh={() => {}} />
          <QuotaCard compact={compact} file={{ name: 'loading.json', provider: 'kimi' }} quota={{ status: 'loading', rows: [] }} onRefresh={() => {}} />
          <QuotaCard compact={compact} file={{ name: 'idle.json', provider: 'kimi' }} quota={{ status: 'idle', rows: [] }} onRefresh={() => {}} />
          {compact ? <QuotaCard compact file={{ name: 'empty.json', provider: 'xai' }} quota={{ status: 'success', rows: [] }} onRefresh={() => {}} /> : null}
        </div>
        <AuthFileQuotaPanel file={claudeFile} quota={claudeQuota} disabled={false} compact dense onRefresh={() => {}} onReset={() => {}} />
      </section>
    </main>
  </I18nProvider>,
);
