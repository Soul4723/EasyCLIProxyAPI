import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_OAUTH_IDS,
  buildXaiCallbackUrl,
  checkCallbackInput,
  isHttpUrl,
  openBrowserId,
  resolveCallbackUrl,
  resolveOAuthBrowserSelection,
  splitAuthUrl,
} from '../src/sections/providers/signin/logic';
import { signinEn, signinJa, signinZhCN } from '../src/sections/providers/signin/i18n';

describe('sign-in browser selection', () => {
  const browsers = [{ id: 'default', label: 'System' }, { id: 'edge', label: 'Edge' }];

  it('keeps a valid preference and never overrides "do not open"', () => {
    expect(resolveOAuthBrowserSelection(browsers, 'edge')).toBe('edge');
    expect(resolveOAuthBrowserSelection(browsers, 'none')).toBe('none');
  });

  it('falls back to the first real browser, then the default, then no auto-open', () => {
    expect(resolveOAuthBrowserSelection(browsers, 'chrome')).toBe('edge');
    expect(resolveOAuthBrowserSelection([browsers[0]], '')).toBe('default');
    expect(resolveOAuthBrowserSelection([], 'chrome')).toBe('none');
  });

  it('opens an explicit click in the default browser when automatic opening is off', () => {
    expect(openBrowserId('none')).toBe('default');
    expect(openBrowserId('')).toBe('default');
    expect(openBrowserId('edge')).toBe('edge');
  });
});

describe('xAI callback building', () => {
  it('passes a full URL through', () => {
    expect(buildXaiCallbackUrl('http://127.0.0.1:56121/callback?code=a&state=b', 's')).toBe('http://127.0.0.1:56121/callback?code=a&state=b');
  });

  it('rebuilds a bare code with the pending state', () => {
    expect(buildXaiCallbackUrl('abc123', 'st')).toBe('http://127.0.0.1:56121/callback?code=abc123&state=st');
  });

  it('rebuilds a query string and prefers the state it carries', () => {
    expect(buildXaiCallbackUrl('?code=c&state=own', 'st')).toBe('http://127.0.0.1:56121/callback?state=own&code=c');
    expect(buildXaiCallbackUrl('code=c', 'st')).toBe('http://127.0.0.1:56121/callback?state=st&code=c');
  });

  it('needs a state for anything that is not a URL', () => {
    expect(buildXaiCallbackUrl('abc123')).toBeNull();
    expect(buildXaiCallbackUrl('   ', 'st')).toBeNull();
  });

  it('only rewrites for xAI', () => {
    expect(resolveCallbackUrl('codex', ' http://localhost/cb?code=1 ', 'st')).toBe('http://localhost/cb?code=1');
    expect(resolveCallbackUrl('xai', 'abc', 'st')).toContain('127.0.0.1:56121');
  });
});

describe('callback validation', () => {
  it('rejects an empty paste for every provider', () => {
    expect(checkCallbackInput('codex', '  ', 's')).toEqual({ ok: false, reason: 'empty' });
    expect(checkCallbackInput('zcode', '', 's', true)).toEqual({ ok: false, reason: 'empty' });
  });

  it('accepts any pasted address for generic built-in providers (the core validates it)', () => {
    expect(checkCallbackInput('codex', ' http://localhost:1455/auth/callback?code=1&state=s ', 's'))
      .toEqual({ ok: true, redirectUrl: 'http://localhost:1455/auth/callback?code=1&state=s' });
  });

  it('holds Devin to its current state', () => {
    expect(checkCallbackInput('devin', 'http://127.0.0.1:8317/callback?state=old&code=c', 'new'))
      .toEqual({ ok: false, reason: 'state_mismatch' });
    expect(checkCallbackInput('devin', 'not a url', 'new')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkCallbackInput('devin', 'http://127.0.0.1:8317/callback?state=new&code=c', 'new').ok).toBe(true);
  });

  it('reports xAI input it cannot rebuild', () => {
    expect(checkCallbackInput('xai', 'abc', undefined)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkCallbackInput('xai', 'abc', 'st')).toEqual({
      ok: true, redirectUrl: 'http://127.0.0.1:56121/callback?code=abc&state=st',
    });
  });

  it('requires plugin callbacks to carry the current state and a code or error', () => {
    const check = (url: string) => checkCallbackInput('zcode', url, 'session-1', true);
    expect(check('http://localhost/cb?code=c&state=session-1').ok).toBe(true);
    expect(check('http://localhost/cb?error=denied&state=session-1').ok).toBe(true);
    expect(check('http://localhost/cb?code=c&state=other')).toEqual({ ok: false, reason: 'invalid' });
    expect(check('http://localhost/cb?state=session-1')).toEqual({ ok: false, reason: 'invalid' });
    expect(check('code=c&state=session-1')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('authorization link helpers', () => {
  it('splits the host so it can be highlighted', () => {
    expect(splitAuthUrl('https://auth.example.com/oauth/authorize?state=a#x'))
      .toEqual({ scheme: 'https://', host: 'auth.example.com', rest: '/oauth/authorize?state=a#x' });
    expect(splitAuthUrl('http://127.0.0.1:1455?x=1')).toEqual({ scheme: 'http://', host: '127.0.0.1:1455', rest: '?x=1' });
    expect(splitAuthUrl('not a url')).toEqual({ scheme: '', host: '', rest: 'not a url' });
  });

  it('only trusts http(s) links from plugins', () => {
    expect(isHttpUrl('https://login.example.test/a')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('nope')).toBe(false);
  });

  it('lists the built-in providers a plugin may not shadow', () => {
    expect(BUILTIN_OAUTH_IDS).toEqual(['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta']);
  });
});

describe('sign-in strings', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it('keeps the same placeholders in every locale', () => {
    for (const key of Object.keys(signinZhCN) as Array<keyof typeof signinZhCN>) {
      expect(placeholders(signinEn[key])).toEqual(placeholders(signinZhCN[key]));
      expect(placeholders(signinJa[key])).toEqual(placeholders(signinZhCN[key]));
    }
  });

  it('has no empty translation', () => {
    for (const table of [signinZhCN, signinEn, signinJa] as Array<Record<string, string>>) {
      for (const value of Object.values(table)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
