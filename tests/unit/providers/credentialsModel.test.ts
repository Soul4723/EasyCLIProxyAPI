import { describe, expect, it } from 'bun:test';
import {
  buildCredentialRow,
  buildCredentialRows,
  credentialBrand,
  credentialStatus,
  defaultCredentialFilter,
  filterCredentials,
  providerFilterCounts,
  requestShare,
  statusFilterCounts,
  summarizeByBrand,
} from '../../../src/sections/providers/creds/model';

const NOW = Date.parse('2026-10-18T04:00:00Z');
const snapshot = { receivedAtMs: NOW, observedAt: '2026-10-18T04:00:00Z' };
const cooldown = (seconds: number, extra: Record<string, unknown> = {}) => ({
  scope: 'model', model_key: 'gpt-fictional', reason: 'quota', http_status: 429,
  retry_at: new Date(NOW + seconds * 1000).toISOString(), remaining_seconds: seconds, ...extra,
});
const file = (extra: Record<string, unknown> = {}) => ({
  name: 'codex-a.json', provider: 'codex', source: 'file', auth_index: 'idx-a', email: 'a@example.test',
  status: 'active', disabled: false, priority: 0, ...extra,
});
const row = (extra: Record<string, unknown> = {}, nowMs = NOW) => buildCredentialRow(file(extra), snapshot, nowMs);

describe('credential status mapping', () => {
  it('maps a healthy active credential to available', () => {
    expect(row().status).toBe('available');
    expect(row({ status: 'ready' }).status).toBe('available');
    expect(row({ status: undefined }).status).toBe('available');
  });

  it('puts disabled above every other state, including cooldown and expiry', () => {
    expect(row({ disabled: true }).status).toBe('disabled');
    expect(row({ status: 'disabled' }).status).toBe('disabled');
    expect(row({ disabled: true, status: 'error', status_message: 'token expired', cooldowns: [cooldown(60)] }).status).toBe('disabled');
  });

  it('recognises sign-in-needed errors as expired, by reason and by message', () => {
    for (const status_message of ['token expired', 'invalid_grant', 'unauthorized', 'Mock OAuth token has expired; sign in again.']) {
      const result = row({ status: 'error', unavailable: true, status_message });
      expect(result.status).toBe('expired');
      expect(result.statusDetail).toBe(status_message);
    }
  });

  it('keeps other core errors as error with the core message', () => {
    const result = row({ status: 'error', unavailable: true, status_message: 'upstream rejected the request' });
    expect(result.status).toBe('error');
    expect(result.statusDetail).toBe('upstream rejected the request');
    expect(row({ unavailable: true }).status).toBe('error');
  });

  it('shows an active cooldown as cooldown and exposes when the earliest one ends', () => {
    const result = row({ status: 'error', status_message: 'quota exhausted', unavailable: true, cooldowns: [cooldown(600), cooldown(120, { model_key: 'm2' })] });
    expect(result.status).toBe('cooldown');
    expect(result.cooldownUntilMs).toBe(NOW + 120_000);
  });

  it('counts down from the server remaining time, not from the wall clock of the record', () => {
    const later = NOW + 119_000;
    expect(credentialStatus(file({ cooldowns: [cooldown(120)] }), NOW, later).cooldownUntilMs).toBe(later + 1000);
    // Once the timer has elapsed the credential reads as available again (the panel still lists the stale record).
    expect(credentialStatus(file({ cooldowns: [cooldown(120)] }), NOW, NOW + 121_000).status).toBe('available');
  });

  it('treats absent, unknown and empty cooldown snapshots as no active cooldown', () => {
    expect(row({ cooldowns: undefined }).status).toBe('available');
    expect(row({ cooldowns: null }).status).toBe('available');
    expect(row({ cooldowns: [] }).status).toBe('available');
    expect(row({ cooldowns: [{ scope: 'bogus' }] }).status).toBe('available');
  });
});

describe('credential rows', () => {
  it('normalizes identity, brand, plan, priority and request totals', () => {
    const result = row({ provider: 'anthropic', plan_type: 'Team', priority: '7', success: 12, failed: 3, name: 'claude-a.json' });
    expect(result).toMatchObject({
      name: 'claude-a.json', provider: 'claude', identity: 'a@example.test', identities: ['a@example.test'],
      plan: 'Team', priority: 7, requests: { ok: 12, fail: 3 }, runtimeOnly: false, editable: true, authIndex: 'idx-a',
    });
    expect(result.key).toBe('claude-a.json#idx-a');
  });

  it('flags runtime-only and API-style entries as not editable and leaves totals empty when the core sent none', () => {
    const runtime = row({ name: 'gemini-runtime', provider: 'gemini', runtime_only: true, source: 'runtime' });
    expect(runtime.runtimeOnly).toBe(true);
    expect(runtime.editable).toBe(false);
    expect(runtime.requests).toBeUndefined();
    expect(row({ account_type: 'api_key' }).editable).toBe(false);
  });

  it('maps provider aliases to kit brand ids and exposes the quota provider only when quota is supported', () => {
    expect(credentialBrand({ type: 'x-ai' })).toBe('xai');
    expect(credentialBrand({ provider: 'cognition' })).toBe('devin');
    expect(credentialBrand({ provider: 'muse' })).toBe('meta');
    expect(credentialBrand({ provider: 'something-new' })).toBe('something-new');
    expect(credentialBrand({})).toBe('other');
    expect(row({ provider: 'codex' }).quotaProvider).toBe('codex');
    expect(row({ provider: 'gemini' }).quotaProvider).toBeNull();
    expect(row({ provider: 'custom-provider', supports_quota: true, auth_index: 'plugin-index' }).quotaProvider).toBe('plugin');
  });

  it('reads the Codex plan from token metadata when the file has no plan field', () => {
    const payload = Buffer.from(JSON.stringify({ chatgpt_plan_type: 'PRO' })).toString('base64url');
    expect(row({ id_token: `h.${payload}.s` }).plan).toBe('pro');
  });
});

const rows = buildCredentialRows({
  ...snapshot,
  files: [
    file({ name: 'codex-1.json', auth_index: '1', email: 'one@example.test' }),
    file({ name: 'codex-2.json', auth_index: '2', email: 'two@example.test', cooldowns: [cooldown(300)] }),
    file({ name: 'claude-1.json', auth_index: '3', provider: 'claude', email: 'three@example.test', disabled: true }),
    file({ name: 'claude-2.json', auth_index: '4', provider: 'claude', email: 'four@example.test', status: 'error', status_message: 'token expired', unavailable: true }),
    file({ name: 'kimi-1.json', auth_index: '5', provider: 'kimi', email: 'five@example.test', status: 'error', status_message: 'boom', unavailable: true }),
  ],
}, NOW);

describe('summaries and filters', () => {
  it('summarizes counts per brand and status', () => {
    const summary = summarizeByBrand(rows);
    expect(summary.get('codex')).toEqual({ total: 2, byStatus: { available: 1, cooldown: 1, disabled: 0, expired: 0, error: 0 } });
    expect(summary.get('claude')?.byStatus).toMatchObject({ disabled: 1, expired: 1 });
    expect(summary.get('kimi')?.byStatus.error).toBe(1);
  });

  it('filters by provider, status, the problems bucket and free text', () => {
    expect(filterCredentials(rows, defaultCredentialFilter)).toHaveLength(5);
    expect(filterCredentials(rows, { provider: 'claude' }).map((item) => item.name)).toEqual(['claude-1.json', 'claude-2.json']);
    expect(filterCredentials(rows, { status: 'disabled' }).map((item) => item.name)).toEqual(['claude-1.json']);
    expect(filterCredentials(rows, { status: 'problems' }).map((item) => item.name).sort()).toEqual(['claude-2.json', 'codex-2.json', 'kimi-1.json']);
    expect(filterCredentials(rows, { query: ' THREE@' }).map((item) => item.name)).toEqual(['claude-1.json']);
    expect(filterCredentials(rows, { query: 'kimi' }).map((item) => item.name)).toEqual(['kimi-1.json']);
    expect(filterCredentials(rows, { provider: 'codex', status: 'problems' }).map((item) => item.name)).toEqual(['codex-2.json']);
  });

  it('searches credential notes and prefixes and includes warning health in Problems', () => {
    const annotated = row({ name: 'pending.json', status: 'pending', note: 'team staging', prefix: 'shared-' });
    expect(filterCredentials([annotated], { query: 'TEAM staging' })).toEqual([annotated]);
    expect(filterCredentials([annotated], { query: 'shared-' })).toEqual([annotated]);
    expect(filterCredentials([annotated], { status: 'problems' })).toEqual([annotated]);
  });

  it('counts chips for the other active filters', () => {
    expect(statusFilterCounts(rows)).toEqual({ all: 5, available: 1, cooldown: 1, disabled: 1, expired: 1, error: 1, problems: 3 });
    expect(statusFilterCounts(filterCredentials(rows, { provider: 'claude' })).problems).toBe(1);
    expect(providerFilterCounts(rows).map((item) => [item.provider, item.count])).toEqual([['claude', 2], ['codex', 2], ['kimi', 1]]);
  });

  it('computes the request mini-bar shares', () => {
    expect(requestShare(undefined)).toBeNull();
    expect(requestShare({ ok: 0, fail: 0 })).toEqual({ okPct: 0, failPct: 0 });
    expect(requestShare({ ok: 75, fail: 25 })).toEqual({ okPct: 75, failPct: 25 });
  });
});
