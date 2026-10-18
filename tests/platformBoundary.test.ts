import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FENCED_COMMANDS } from '../src/mocks/fencedCommands';

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

const appSources = sources.filter((f) => !f.includes('/src/mocks/'));
const INVOKE_CALL = /\binvoke(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*(['"])([a-z0-9_]+)\1/g;

function nativeFencedCommands(): string[] {
  const names = new Set<string>();
  const rustFiles = walk(join(root, 'src-tauri/src')).filter((f) => f.endsWith('.rs'));
  for (const f of rustFiles) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/#\[tauri::command[^\]]*\]\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      while (depth > 0) { depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0; i++; }
      if (text.slice(m.index! + m[0].length, i).includes('expected_revision')) names.add(m[1]);
    }
  }
  return [...names].sort();
}

describe('platform boundary', () => {
  test('no @tauri-apps import outside src/services and src/mocks', () => {
    const offenders = sources
      .map((f) => relative(root, f))
      .filter((f) => !/^src\/(services|mocks)\//.test(f) && !allowlist.includes(f))
      .filter((f) => /@tauri-apps\//.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('every literal invoke command in src (outside mocks) is registered in generate_handler!', () => {
    const main = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
    const block = main.slice(main.indexOf('generate_handler!['));
    const registered = new Set(block.slice(0, block.indexOf(']')).match(/[A-Za-z_][A-Za-z0-9_]*/g));
    const missing: string[] = [];
    for (const f of appSources) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\binvoke(?:<[^>(]*>)?\(\s*'([a-z0-9_]+)'/g)) {
        if (!registered.has(m[1])) missing.push(`${relative(root, f)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the mock fence list equals the native commands that take expected_revision', () => {
    expect([...FENCED_COMMANDS].sort()).toEqual(nativeFencedCommands());
  });

  test('src never calls a fenced command through an unfenced invoke', () => {
    // Fenced commands need the document revision (services/documentTarget binds it). A file whose `invoke`
    // is the raw platform/Tauri one may only call them when it passes expectedRevision itself.
    const offenders: string[] = [];
    for (const f of appSources.filter((p) => !p.endsWith('/services/documentTarget.ts'))) {
      const text = readFileSync(f, 'utf8');
      // usageApi.invoke is documentTarget.invoke.
      const fenced = /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*['"][^'"]*\/(?:documentTarget|usageApi)['"]/.test(text);
      if (fenced) continue;
      for (const m of text.matchAll(INVOKE_CALL)) {
        const command = m[2];
        if (command !== 'management_request' && !FENCED_COMMANDS.has(command)) continue;
        if (!/expectedRevision/.test(text.slice(m.index!, m.index! + 400))) offenders.push(`${relative(root, f)}: ${command}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the boundary check catches the plugin OAuth regression shape', () => {
    const source = "import { invoke } from '../../services/platform';\nawait invoke<OAuthStart>('start_oauth_login', { provider });";
    const hit = [...source.matchAll(INVOKE_CALL)].filter((m) => FENCED_COMMANDS.has(m[2]) && !/expectedRevision/.test(source.slice(m.index!, m.index! + 400)));
    expect(hit.map((m) => m[2])).toEqual(['start_oauth_login']);
  });
});
