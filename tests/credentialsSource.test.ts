import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

const dir = new URL('../src/sections/providers/creds/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

/** Calls made inside the initializer of the variable `action` (e.g. a useCallback). */
function callsIn(file: string, action: string, callee: string) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: ts.CallExpression[] = [];
  let found = false;
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === callee) calls.push(node);
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === action && node.initializer) {
      found = true;
      collect(node.initializer);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  expect(found).toBe(true);
  return calls;
}

describe('credentials controller behaviour (source contract)', () => {
  it('the enable toggle reports only failures and refreshes in the background', () => {
    const notices = callsIn('useCredentials.tsx', 'toggle', 'notify');
    expect(notices).toHaveLength(0);
    const failures = callsIn('useCredentials.tsx', 'toggle', 'failure');
    expect(failures).toHaveLength(1);
    const loads = callsIn('useCredentials.tsx', 'toggle', 'load');
    expect(loads).toHaveLength(1);
    expect(loads[0].arguments[0].getText()).toBe('false');
  });

  it('delete and cooldown reset always go through a confirmation first', () => {
    const remove = callsIn('useCredentials.tsx', 'remove', 'setConfirm');
    expect(remove).toHaveLength(1);
    expect(remove[0].arguments[0].getText()).toContain("kind: 'delete'");
    const clear = callsIn('useCredentials.tsx', 'clearCooldown', 'setConfirm');
    expect(clear).toHaveLength(1);
    expect(clear[0].arguments[0].getText()).toContain("kind: 'cooldown'");
    expect(callsIn('useCredentials.tsx', 'remove', 'managementApi.delete')).toHaveLength(0);
    expect(callsIn('useCredentials.tsx', 'clearCooldown', 'resetAuthFileCooldown')).toHaveLength(0);
  });

  it('a cooldown reset sends only the credential auth index through the service helper', () => {
    const source = read('useCredentials.tsx');
    expect(source).toContain('resetAuthFileCooldown(index)');
    expect(source).not.toMatch(/managementApi\.post/);
    // Reset invalidates reads started earlier so a stale list cannot bring the cooldown back.
    expect(source).toMatch(/requestRef\.current \+= 1;\s*setSnapshot/);
  });

  it('keeps quota refresh out of the credentials package (the Quota section owns it)', () => {
    for (const name of readdirSync(dir).filter((file) => /\.(ts|tsx)$/.test(file))) {
      const source = read(name);
      expect(source).not.toMatch(/loadQuota|quotaCache|startQuotaOperation|commitFetchedQuota/);
    }
  });

  it('never uses native or browser confirmation dialogs', () => {
    for (const name of readdirSync(dir).filter((file) => /\.(ts|tsx)$/.test(file))) {
      const source = read(name);
      expect(source).not.toContain('window.confirm');
      expect(source).not.toContain('@tauri-apps/plugin-dialog');
    }
  });

  it('exposes the open-folder reason in remote mode and never calls the folder command then', () => {
    const open = callsIn('useCredentials.tsx', 'openFolder', 'managementApi.openAuthFilesDirectory');
    expect(open).toHaveLength(1);
    const source = read('useCredentials.tsx');
    expect(source).toContain("const remote = coreStatus?.connectionMode === 'remote'");
    expect(source).toMatch(/if \(remote\) return;/);
    expect(source).toContain("sec.providers.creds.openFolder.remote");
  });
});
