import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

type Record = { [key: string]: unknown };
const PROVIDERS = ['claude', 'codex', 'claude', 'antigravity', 'xai', 'codex', 'kimi', 'devin', 'codex', 'claude'] as const;
const QUOTA_PROVIDERS = new Set(['claude', 'codex', 'kimi', 'xai', 'antigravity', 'devin', 'anthropic', 'cognition', 'grok']);
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

/** Fictional accounts for `?quotaAccounts=N`: a deterministic mix of healthy, disabled, cooling, expired and failing ones. */
export function generateQuotaAccounts(count: number): Record[] {
  return Array.from({ length: count }, (_, index) => {
    const provider = PROVIDERS[index % PROVIDERS.length];
    const name = `${provider}-gen-${index + 1}`;
    const extra: Record = {};
    if (index % 11 === 6) extra.disabled = true;
    else if (index % 9 === 4) extra.cooldowns = [{ scope: 'credential', reason: 'quota', http_status: 429, retry_at: future(2), remaining_seconds: 7200 }];
    else if (index % 13 === 8) Object.assign(extra, { status: 'error', status_message: 'Mock OAuth token has expired; sign in again.' });
    return {
      name: `${name}.json`, provider, type: provider, source: 'file', auth_index: `mock-${provider}-gen-${index + 1}`,
      email: `person${index + 1}@example.test`, account_id: `mock-gen-${index + 1}`, plan_type: index % 3 ? 'pro' : 'max',
      disabled: false, status: 'active', priority: index % 3, success: 40 + index * 7, failed: index % 5, size: 1500,
      modtime: Date.now() - index * 90_000, ...extra,
    };
  });
}

/**
 * Browser-mock handlers owned by the quota section. Extra URL parameter: `?quotaAccounts=N` replaces the quota
 * providers' fixture credentials with N generated ones (0 = none), for few/many/empty-list states. In-memory only.
 */
export const quotaMock: SectionMockFactory = (host) => {
  const raw = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('quotaAccounts');
  const count = raw === null ? NaN : Number(raw);
  const files = (host as unknown as { authFiles?: Record[] }).authFiles;
  if (Number.isInteger(count) && count >= 0 && Array.isArray(files)) {
    const kept = files.filter((file) => !QUOTA_PROVIDERS.has(String(file.provider ?? file.type ?? '').toLowerCase()));
    files.splice(0, files.length, ...kept, ...generateQuotaAccounts(count));
  }
  if (raw === null && Array.isArray(files) && host.scenario === 'running') {
    // Accounts the lighting mock already has schedules for, so the ⚡ states are visible by default.
    files.push(...['codex', 'claude'].map((provider, index) => ({
      name: `${provider}-preview-account.json`, provider, type: provider, source: 'file',
      auth_index: `preview-${provider}-account`, email: `preview-${provider}@example.test`, account_id: `mock-preview-${provider}`,
      plan_type: 'pro', disabled: false, status: 'active', priority: 2, success: 120 + index * 30, failed: 2, size: 1500, modtime: Date.now(),
    })));
  }
  return { handle: () => ({ handled: false }) };
};
