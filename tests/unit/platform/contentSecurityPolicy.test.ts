import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

type Csp = Record<string, string>;

const config = JSON.parse(
  readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);
const csp = config.app.security.csp as Csp;
const sources = (directive: string) => (csp[directive] ?? '').split(/\s+/).filter(Boolean);

describe('main window content security policy', () => {
  it('is set and defaults to the app origin only', () => {
    expect(csp).toBeTruthy();
    expect(csp['default-src']).toBe("'self'");
  });

  it('never allows eval, remote scripts or wildcards', () => {
    for (const [directive, value] of Object.entries(csp)) {
      expect(value, directive).not.toContain("'unsafe-eval'");
      expect(value, directive).not.toMatch(/(^|\s)(\*|https?:)(\s|$)/);
    }
    expect(sources('script-src')).toEqual(["'self'"]);
  });

  it('lets the frontend reach only Tauri IPC', () => {
    expect(sources('connect-src')).toEqual(["'self'", 'ipc:', 'http://ipc.localhost']);
  });

  it('blocks plugins and base-tag rewrites', () => {
    expect(csp['object-src']).toBe("'none'");
    expect(csp['base-uri']).toBe("'none'");
  });
});
