import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
// Justified exceptions: none. All Tauri access goes through src/services (platform.ts).
const allowlist: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = walk(join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));

describe('platform boundary', () => {
  test('no @tauri-apps import outside src/services and src/mocks', () => {
    const offenders = sources
      .map((f) => relative(root, f))
      .filter((f) => !/^src\/(services|mocks)\//.test(f) && !allowlist.includes(f))
      .filter((f) => /@tauri-apps\//.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('every literal invoke command in src/services is registered in generate_handler!', () => {
    const main = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
    const block = main.slice(main.indexOf('generate_handler!['));
    const registered = new Set(block.slice(0, block.indexOf(']')).match(/[A-Za-z_][A-Za-z0-9_]*/g));
    const missing: string[] = [];
    for (const f of sources.filter((s) => s.includes('/src/services/'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\binvoke(?:<[^>(]*>)?\(\s*'([a-z0-9_]+)'/g)) {
        if (!registered.has(m[1])) missing.push(`${relative(root, f)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
