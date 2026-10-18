import type { SectionMockFactory } from '../../../mocks/sectionMockTypes';

type Rec = Record<string, unknown>;

/**
 * Browser-mock handlers for the creds part of Providers; chained from ../mock.ts.
 *
 * The shared mock already serves /credentials, settings, models, cooldown reset and deletion from `host.authFiles`.
 * This module only reseeds that list for rendered checks: `?creds=one|states|forty` (any scenario except `empty`/`error`
 * keep their own data when the parameter is absent).
 */
const BRANDS = ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'codex', 'claude'] as const;
const PLANS = ['Pro 20x', 'Team', 'Plus', 'Free', '', 'Max'];

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

function requests(seed: number): Rec[] {
  return Array.from({ length: 20 }, (_, bucket) => ({
    time: new Date(Date.now() - (19 - bucket) * 600_000).toISOString(),
    success: (bucket + seed) % 5 + 1,
    failed: (bucket + seed) % 9 === 0 ? 1 : 0,
  }));
}

function credential(brand: string, label: string, index: number, extra: Rec = {}): Rec {
  return {
    name: `${brand}-${label}.json`, provider: brand, type: brand, source: 'file', auth_index: `mock-${brand}-${label}`,
    email: `${label}@example.test`, account_id: `mock-account-${index}`, plan_type: PLANS[index % PLANS.length],
    disabled: false, status: 'active', priority: index % 4 === 0 ? 5 : 0, size: 1500 + index * 37,
    modtime: Date.now() - index * 90_000, success: 120 + index * 31, failed: index % 6, recent_requests: requests(index),
    note: '', excluded_models: [], cooldowns: [], ...extra,
  };
}

export function statesFixture(): Rec[] {
  return [
    credential('codex', 'primary-account-with-a-very-long-name-for-layout', 0, { priority: 5, plan_type: 'Pro 20x', success: 12840, failed: 12 }),
    credential('codex', 'cooling', 1, {
      status: 'error', status_message: 'quota exhausted', unavailable: true,
      cooldowns: [
        { scope: 'model', model_key: 'gpt-5.2-codex', reason: 'quota', http_status: 429, backoff_level: 1, retry_at: minutes(42), remaining_seconds: 42 * 60 },
        { scope: 'model', model_key: 'gpt-5.2-mini', reason: 'quota', http_status: 429, retry_at: minutes(95), remaining_seconds: 95 * 60 },
      ],
    }),
    credential('codex', 'wide-cooldown', 2, {
      cooldowns: [{ scope: 'credential', reason: 'transient_error', http_status: 503, retry_at: minutes(3), remaining_seconds: 180 }],
    }),
    credential('claude', 'disabled', 3, { disabled: true, status: 'disabled' }),
    credential('claude', 'expired-token', 4, { status: 'error', status_message: 'token expired', unavailable: true }),
    credential('antigravity', 'rejected', 5, { status: 'error', status_message: 'upstream rejected the request', unavailable: true }),
    credential('kimi', 'personal', 6, { note: 'Fictional personal account' }),
    credential('xai', 'api-paid', 7, { using_api: true, prefix: 'paid', websockets: true }),
    credential('devin', 'team', 8, { success: 0, failed: 0, recent_requests: [] }),
    {
      name: 'gemini-runtime', provider: 'gemini', type: 'gemini', source: 'runtime', runtime_only: true,
      auth_index: 'mock-gemini-runtime', disabled: false, success: 27, failed: 0,
    },
  ];
}

export function forty(): Rec[] {
  return Array.from({ length: 40 }, (_, index) => {
    const brand = BRANDS[index % BRANDS.length];
    const label = `account-${String(index + 1).padStart(2, '0')}`;
    if (index % 11 === 3) return credential(brand, label, index, { disabled: true, status: 'disabled' });
    if (index % 13 === 5) return credential(brand, label, index, { status: 'error', status_message: 'token expired', unavailable: true });
    if (index % 9 === 4) {
      return credential(brand, label, index, {
        cooldowns: [{ scope: 'model', model_key: 'model-x', reason: 'quota', http_status: 429, retry_at: minutes(20 + index), remaining_seconds: (20 + index) * 60 }],
      });
    }
    return credential(brand, label, index);
  });
}

export const credsMock: SectionMockFactory = (host) => {
  const fixture = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('creds');
  if (fixture && Array.isArray(host.authFiles) && host.scenario !== 'empty') {
    const next = fixture === 'one' ? statesFixture().slice(0, 1) : fixture === 'forty' ? forty() : statesFixture();
    host.authFiles.splice(0, host.authFiles.length, ...next);
  }
  return { handle: () => ({ handled: false }) };
};
