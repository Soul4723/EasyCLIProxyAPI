import { describe, expect, it } from 'bun:test';
import { deriveAccountPresentation } from '../src/services/accountPresentation';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

describe('account presentation foundation', () => {
  it('uses source identity, not account labels, and keeps conflicting indexes separate', () => {
    const file = { name: 'same.json', auth_index: 0, email: 'same@example.test', source: 'file' };
    const first = deriveAccountPresentation(file);
    const second = deriveAccountPresentation({ ...file, auth_index: 'other' });
    expect(first.key).toBe(quotaKey(file));
    expect(first.key).not.toBe(second.key);
    expect(first.label).toBe(second.label);
    expect(first.source).toEqual({
      name: 'same.json', authIndex: '0', source: 'file', runtimeOnly: false, oauthCredentialFile: true,
    });
    expect(deriveAccountPresentation({ ...file, auth_index: undefined, authIndex: ' 0 ' }).key).toBe(first.key);
    expect(deriveAccountPresentation({ email: file.email }).key).toBeNull();
    expect(deriveAccountPresentation({}).label).toBeNull();
  });

  it('keeps provider identity separate from supported quota aliases', () => {
    for (const [raw, id, quotaProvider] of [
      ['anthropic', 'claude', 'claude'],
      ['cognition', 'devin', 'devin'],
      ['anti-gravity', 'antigravity', 'antigravity'],
      ['grok', 'grok', 'xai'],
      ['openai', 'codex', null],
      ['muse', 'meta', null],
      ['custom-plugin', 'custom-plugin', null],
      ['', null, null],
    ]) {
      expect(deriveAccountPresentation({ type: raw }).provider).toEqual({ raw, id, quotaProvider });
    }
  });

  it('retains display identity and source semantics without projecting secrets', () => {
    const result = deriveAccountPresentation({
      name: 'account.json', provider: 'codex', email: 'user@example.test', account: 'account',
      account_id: 'account-id', projectId: 'project', source: 'memory', runtime_only: true,
      access_token: 'secret-access', api_key: 'secret-key', metadata: { id_token: 'secret-id' },
    });
    expect(result.label).toBe('user@example.test');
    expect(result.identities).toEqual(['user@example.test', 'account', 'account-id', 'project']);
    expect(result.source.runtimeOnly).toBe(true);
    expect(result.source.oauthCredentialFile).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(deriveAccountPresentation({ name: 'a.json', account: 'Account', label: 'Label' }).label).toBe('Account');
    expect(deriveAccountPresentation({ name: 'a.json', label: 'Label' }).label).toBe('Label');
    expect(deriveAccountPresentation({ name: 'a.json' }).label).toBe('a.json');
  });

  it('distinguishes unfetched, idle, loading, error and successful empty snapshots', () => {
    expect(deriveAccountPresentation({}).quota.status).toBe('unfetched');
    for (const status of ['idle', 'loading', 'error', 'success'] as const) {
      const summary = deriveAccountPresentation({}, { status, rows: [], error: status === 'error' ? 'Failed' : undefined }).quota;
      expect(summary.status).toBe(status);
      expect(summary.rows).toEqual([]);
      expect(summary.measurements).toEqual({ unavailable: 0, exhausted: 0, remaining: 0 });
      expect(summary.error).toBe(status === 'error' ? 'Failed' : undefined);
    }
  });

  it('preserves mixed unavailable and zero windows, reset evidence and credit values', () => {
    const summary = deriveAccountPresentation({}, {
      status: 'success', fetchedAt: 123, plan: 'team', creditBalance: '0', creditsUnlimited: false,
      rows: [
        { label: 'Unknown', remainingPercent: null, detail: 'No measurement' },
        { label: 'Hourly', remainingPercent: 0, reset: 'Later', resetAtMs: 456 },
        { label: 'Weekly', remainingPercent: 75 },
      ],
    }).quota;
    expect(summary.rows.map((row) => row.measurement)).toEqual(['unavailable', 'exhausted', 'remaining']);
    expect(summary.rows[1]).toMatchObject({ remainingPercent: 0, reset: 'Later', resetAtMs: 456 });
    expect(summary.measurements).toEqual({ unavailable: 1, exhausted: 1, remaining: 1 });
    expect(summary).toMatchObject({ fetchedAt: 123, plan: 'team', creditBalance: '0', creditsUnlimited: false });
  });

  it('treats malformed percentages as unavailable, not exhausted or unlimited', () => {
    for (const remainingPercent of [NaN, Infinity, -1, 101]) {
      expect(deriveAccountPresentation({}, {
        status: 'success', rows: [{ label: 'Invalid', remainingPercent }],
      }).quota.rows[0]).toMatchObject({ remainingPercent: null, measurement: 'unavailable' });
    }
  });

  it('does not infer health from quota or discard old measurements during refresh errors', () => {
    const quota: QuotaState = { status: 'error', error: 'Refresh failed', fetchedAt: 123, rows: [{ label: 'Window', remainingPercent: 0 }] };
    expect(deriveAccountPresentation({ status: 'active' }, quota).health.tone).toBe('success');
    expect(deriveAccountPresentation({}, quota).health.label).toBe('authFiles.health.unknown');
    expect(deriveAccountPresentation({ disabled: true }, { ...quota, status: 'success', rows: [] }).health.disabled).toBe(true);
    for (const status of ['loading', 'error'] as const) {
      expect(deriveAccountPresentation({}, { ...quota, status }).quota).toMatchObject({
        status, fetchedAt: 123, rows: [{ measurement: 'exhausted', remainingPercent: 0 }],
      });
    }
  });

  it('does not mutate or alias the input snapshot', () => {
    const file = Object.freeze({ name: 'a.json', provider: 'codex' });
    const row = Object.freeze({ label: 'Window', remainingPercent: 0 });
    const quota: QuotaState = { status: 'success', rows: [row] };
    Object.freeze(quota.rows);
    Object.freeze(quota);
    const result = deriveAccountPresentation(file, quota);
    result.quota.rows[0].remainingPercent = 99;
    expect(quota.rows[0].remainingPercent).toBe(0);
    expect(deriveAccountPresentation(file, quota).quota.rows[0].remainingPercent).toBe(0);
  });
});
