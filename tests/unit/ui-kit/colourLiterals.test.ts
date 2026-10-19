import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Colour-literal lint for the new UI: src/ui/** and src/sections/** must take colours from the --ec-* tokens.
// src/ui/tokens.css is the only place that defines raw colours (transparent/currentColor/inherit are fine).
const root = join(import.meta.dir, '../../..');
const scanned = ['src/ui', 'src/sections'];
const excluded = new Set(['src/ui/tokens.css']);

const literal = /(^|[^\w&#-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx)$/.test(name) ? [path] : [];
  });
}

function stripComments(source: string, path: string) {
  const blocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
  return path.endsWith('.tsx') ? blocks.replace(/(^|\s)\/\/.*$/gm, (match) => match.replace(/[^\n]/g, ' ')) : blocks;
}

export function colourLiteralViolations(source: string, path: string) {
  const text = stripComments(source, path);
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(literal)) found.push(`${path}:${index + 1}: ${match[0].trim()}`);
  });
  return found;
}

describe('colour literals', () => {
  test('the detector flags hex, rgb, hsl and oklch but allows keywords and var()', () => {
    expect(colourLiteralViolations('a { color: #fff; }', 'a.css')).toHaveLength(1);
    expect(colourLiteralViolations('a { color: #ffaa00cc; }', 'a.css')).toHaveLength(1);
    expect(colourLiteralViolations('a { box-shadow: 0 0 1px rgb(0 0 0 / 8%); }', 'a.css')).toHaveLength(1);
    expect(colourLiteralViolations('const s = { color: "hsl(10 20% 30%)" };', 'a.tsx')).toHaveLength(1);
    expect(colourLiteralViolations('a { color: oklch(0.7 0.1 30); }', 'a.css')).toHaveLength(1);
    expect(colourLiteralViolations('a { color: transparent; border-color: currentColor; background: inherit; }', 'a.css')).toEqual([]);
    expect(colourLiteralViolations('a { color: var(--ec-fg); background: color-mix(in srgb, var(--ec-accent) 10%, transparent); }', 'a.css')).toEqual([]);
    expect(colourLiteralViolations('/* #fff rgb(0,0,0) */ a { color: var(--ec-fg); }', 'a.css')).toEqual([]);
    expect(colourLiteralViolations('<a href="#/usage">x</a> &#1234; // #fff rgb(0,0,0)', 'a.tsx')).toEqual([]);
  });

  test('src/ui and src/sections styles use tokens only', () => {
    const violations = scanned.flatMap((dir) => files(join(root, dir)))
      .filter((path) => !excluded.has(relative(root, path)))
      .flatMap((path) => colourLiteralViolations(readFileSync(path, 'utf8'), relative(root, path)));
    expect(violations).toEqual([]);
  });
});
