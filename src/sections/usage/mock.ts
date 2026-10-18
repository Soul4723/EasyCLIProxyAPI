import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/**
 * Browser-mock handlers owned by the usage section (see src/mocks/sectionMocks.ts):
 * get_usage_events and get_usage_analysis (filter option lists) over one deterministic fixture set.
 * Credentials mirror src/mocks/browserMockRuntime.ts and src/mocks/quotaMock.ts so `auth_index` links resolve.
 */
type Json = Record<string, unknown>;
type Account = { provider: string; authIndex: string; email: string; authType: 'oauth' | 'apikey'; models: string[] };
type ModelDef = { model: string; alias: string; response: string; prompt: number; completion: number; effort: string };
type Event = {
  id: string; row_id: string; timestamp: string; latency_ms: number; ttft_ms: number | null;
  source: string; source_display: string; failed: boolean; canceled: boolean; failure_status: number; failure_body: string;
  provider: string; agent: string; auth_type: string; model: string; response_model: string;
  cost: { total: number; pricing_model: string } | null; alias: string; reasoning_effort: string;
  service_tier: string; response_service_tier: string; endpoint: string;
  api_key_hash: string; api_key_display: string; api_key_remark: string;
  tokens: { input_tokens: number; output_tokens: number; reasoning_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; total_tokens: number };
};

const MODELS: Record<string, ModelDef> = {
  'gpt-5.5': { model: 'gpt-5.5', alias: '', response: 'gpt-5.5', prompt: 1.25, completion: 10, effort: 'high' },
  'gpt-5.2-codex': { model: 'gpt-5.2-codex', alias: 'codex-fast', response: 'gpt-5.2-codex', prompt: 1.25, completion: 10, effort: 'medium' },
  'claude-opus-4-6': { model: 'claude-opus-4-6', alias: '', response: 'claude-opus-4-6', prompt: 15, completion: 75, effort: 'high' },
  'claude-sonnet-4-6': { model: 'claude-sonnet-4-6', alias: 'sonnet', response: 'claude-sonnet-4-6-20260101', prompt: 3, completion: 15, effort: 'medium' },
  'gemini-3-pro': { model: 'gemini-3-pro', alias: '', response: 'gemini-3-pro', prompt: 2, completion: 12, effort: 'auto' },
  'grok-4': { model: 'grok-4', alias: '', response: 'grok-4', prompt: 3, completion: 15, effort: 'low' },
  'kimi-k2.5': { model: 'kimi-k2.5', alias: 'kimi', response: 'kimi-k2.5', prompt: 0.6, completion: 2.5, effort: 'auto' },
};

const ACCOUNTS: Account[] = [
  { provider: 'codex', authIndex: 'mock-codex-1', email: 'codex.mock@example.test', authType: 'oauth', models: ['gpt-5.5', 'gpt-5.2-codex'] },
  { provider: 'codex', authIndex: 'mock-codex-exhausted', email: 'exhausted@example.test', authType: 'oauth', models: ['gpt-5.2-codex', 'gpt-5.5'] },
  { provider: 'claude', authIndex: 'mock-claude-1', email: 'claude.mock@example.test', authType: 'oauth', models: ['claude-opus-4-6', 'claude-sonnet-4-6'] },
  { provider: 'claude', authIndex: 'mock-claude-expired', email: 'expired@example.test', authType: 'oauth', models: ['claude-sonnet-4-6'] },
  { provider: 'antigravity', authIndex: 'mock-antigravity-team-with-a-long-account-name', email: 'team-with-a-long-account-name@example.test', authType: 'oauth', models: ['gemini-3-pro', 'claude-sonnet-4-6'] },
  { provider: 'xai', authIndex: 'mock-xai-subscription', email: 'subscription@example.test', authType: 'oauth', models: ['grok-4'] },
  { provider: 'kimi', authIndex: 'mock-kimi-personal', email: 'personal@example.test', authType: 'oauth', models: ['kimi-k2.5'] },
  { provider: 'gemini', authIndex: 'mock-gemini-runtime', email: 'gemini-runtime@example.test', authType: 'apikey', models: ['gemini-3-pro'] },
];

const KEYS = [
  { hash: 'key-hash-laptop', display: 'sk-lap…4f2a', remark: 'Laptop' },
  { hash: 'key-hash-ci', display: 'sk-ci-…91c7', remark: 'CI runner' },
  { hash: 'key-hash-shared', display: 'sk-sha…d003', remark: '' },
];

const AGENTS = ['codex', 'claude-code', 'gemini-cli', 'unknown'];
const ENDPOINTS: Record<string, string> = {
  codex: 'POST /v1/responses', claude: 'POST /v1/messages', antigravity: 'POST /v1beta/models:streamGenerateContent',
  xai: 'POST /v1/chat/completions', kimi: 'POST /v1/chat/completions', gemini: 'POST /v1beta/models:generateContent',
};
const FAILURES: { status: number; body: string }[] = [
  { status: 429, body: '{"error":{"type":"rate_limit_error","message":"Rate limit reached for requests. Please retry after 20 seconds."}}' },
  { status: 500, body: '{"error":{"type":"server_error","message":"The upstream provider returned an internal error.","request_id":"req_mock_8f21"}}' },
  { status: 401, body: '{"error":{"type":"authentication_error","message":"Invalid or expired credential."}}' },
  { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Quota exhausted for this window', details: Array.from({ length: 12 }, (_, i) => ({ window: i % 2 ? 'weekly' : '5h', reset_in_s: 3600 * (i + 1), limit: 1000 })) } }, null, 2) },
];

const asObject = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function buildEvents(): Event[] {
  let seed = 20261018;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
  const now = Date.now();
  const count = 184;
  const events: Event[] = [];
  for (let i = 0; i < count; i += 1) {
    // Denser near "now" (so 4h/24h windows are populated) with a long tail over 7 days.
    const ageMs = Math.pow(i / count, 1.9) * 7 * 24 * 3_600_000 + i * 20_000;
    const account = pick(ACCOUNTS);
    const def = MODELS[pick(account.models)];
    const key = pick(KEYS);
    const roll = rand();
    const canceled = roll > 0.975;
    const failed = !canceled && roll > 0.9;
    const failure = failed ? pick(FAILURES) : null;
    const input = Math.round(400 + rand() * rand() * 90_000);
    const cacheRead = rand() > 0.35 ? Math.round(input * (0.2 + rand() * 0.7)) : 0;
    const cacheCreation = rand() > 0.8 ? Math.round(input * 0.05) : 0;
    const output = failed || canceled ? 0 : Math.round(30 + rand() * rand() * 6_000);
    const reasoning = def.effort === 'auto' || failed ? 0 : Math.round(output * rand() * 0.5);
    const latency = failed ? Math.round(120 + rand() * 900) : Math.round(700 + rand() * rand() * 42_000);
    const costTotal = ((input - cacheRead) * def.prompt + cacheRead * def.prompt * 0.1 + output * def.completion) / 1_000_000;
    const timestamp = new Date(now - ageMs).toISOString();
    const fast = rand() > 0.85;
    events.push({
      id: `evt-${String(i).padStart(4, '0')}-${Math.floor(rand() * 0xffffff).toString(16)}`,
      row_id: `row-${i}`,
      timestamp,
      latency_ms: latency,
      ttft_ms: failed ? null : Math.round(latency * (0.08 + rand() * 0.3)),
      source: account.authIndex,
      source_display: account.email,
      failed,
      canceled,
      failure_status: failure?.status ?? (canceled ? 499 : 0),
      failure_body: failure?.body ?? '',
      provider: account.provider,
      agent: account.provider === 'claude' ? pick(['claude-code', 'claude-code', 'unknown']) : account.provider === 'codex' ? pick(['codex', 'codex', 'unknown']) : account.provider === 'gemini' ? 'gemini-cli' : pick(AGENTS),
      auth_type: account.authType,
      model: def.model,
      response_model: def.response,
      cost: failed || i % 17 === 5 ? null : { total: costTotal, pricing_model: def.model },
      alias: def.alias,
      reasoning_effort: def.effort,
      service_tier: fast ? 'priority' : '',
      response_service_tier: fast ? 'priority' : 'default',
      endpoint: ENDPOINTS[account.provider] ?? 'POST /v1/chat/completions',
      api_key_hash: key.hash,
      api_key_display: key.display,
      api_key_remark: key.remark,
      tokens: {
        input_tokens: input, output_tokens: output, reasoning_tokens: reasoning,
        cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation, total_tokens: input + output,
      },
    });
  }
  return events;
}

function inWindow(events: Event[], query: Json): Event[] {
  const start = query.start ? Date.parse(String(query.start)) : null;
  const end = query.end ? Date.parse(String(query.end)) : null;
  return events.filter((e) => {
    const at = Date.parse(e.timestamp);
    return (start === null || at >= start) && (end === null || at <= end);
  });
}

function matches(event: Event, query: Json): boolean {
  if (query.model && event.model !== query.model) return false;
  if (query.agent && event.agent !== query.agent) return false;
  if (query.provider && event.provider !== query.provider) return false;
  if (query.api_key_hash && event.api_key_hash !== query.api_key_hash) return false;
  if (query.source && event.source !== query.source) return false;
  if (typeof query.upstream === 'string' && query.upstream) {
    const [kind, ...rest] = query.upstream.split(':');
    const value = rest.join(':');
    if (kind === 'auth' && event.source !== value) return false;
    if (kind === 'provider' && event.provider !== value) return false;
  }
  if (typeof query.failed === 'boolean' && event.failed !== query.failed) return false;
  if (typeof query.canceled === 'boolean' && event.canceled !== query.canceled) return false;
  return true;
}

function category(events: Event[], keyOf: (e: Event) => string, labelOf: (e: Event) => string) {
  const map = new Map<string, { key: string; label: string; requests: number; failures: number; tokens: number; provider: string }>();
  for (const e of events) {
    const key = keyOf(e);
    const row = map.get(key) ?? { key, label: labelOf(e), requests: 0, failures: 0, tokens: 0, provider: e.provider };
    row.requests += 1;
    row.failures += e.failed ? 1 : 0;
    row.tokens += e.tokens.total_tokens;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.requests - a.requests);
}

export const usageMock: SectionMockFactory = (host) => {
  const all = buildEvents();
  const scenario = () => host.scenario;
  return {
    handle(command, payload) {
      if (command === 'get_usage_events') {
        if (scenario() === 'error') throw new Error('Mock usage database is unavailable');
        const query = asObject(payload.query);
        const page = Math.max(1, num(query.page, 1));
        const pageSize = Math.max(1, num(query.page_size, 50));
        const rows = scenario() === 'empty' ? [] : inWindow(all, query).filter((e) => matches(e, query));
        const start = (page - 1) * pageSize;
        return {
          handled: true,
          value: structuredClone({ items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) }),
        };
      }
      if (command === 'get_usage_analysis') {
        if (scenario() === 'error') return { handled: false };
        const rows = scenario() === 'empty' ? [] : inWindow(all, asObject(payload.query));
        const strip = ({ provider: _provider, ...rest }: ReturnType<typeof category>[number]) => rest;
        return {
          handled: true,
          value: {
            models: category(rows, (e) => e.model, (e) => e.model).map(strip),
            providers: category(rows, (e) => e.provider, (e) => e.provider).map(strip),
            sources: category(rows, (e) => e.source, (e) => e.source_display).map(strip),
            apiKeys: category(rows, (e) => e.api_key_hash, (e) => e.api_key_remark ? `${e.api_key_display} · ${e.api_key_remark}` : e.api_key_display).map(strip),
            upstreams: category(rows, (e) => `auth:${e.source}`, (e) => e.source_display),
          },
        };
      }
      return { handled: false };
    },
  };
};
