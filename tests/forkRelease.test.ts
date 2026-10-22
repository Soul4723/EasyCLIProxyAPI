import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error build tooling is plain JavaScript
import { assertChannelAdvance, readForkBaseVersion } from '../scripts/fork-release.mjs';

describe('fork release base version', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  const source = async () => {
    const root = await mkdtemp(join(tmpdir(), 'fork-release-'));
    roots.push(root);
    await mkdir(join(root, 'src-tauri'));
    await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nversion = "0.3.6-dev.1"\n');
    return root;
  };

  test('uses the highest numeric release-note directory instead of stale Cargo', async () => {
    const root = await source();
    for (const version of ['0.2.100', '0.3.9', '0.3.50', '0.3.10']) {
      await mkdir(join(root, 'docs', 'release-notes', `v${version}`), { recursive: true });
    }
    expect(await readForkBaseVersion(root)).toBe('0.3.50');
    await mkdir(join(root, 'docs', 'release-notes', 'v0.10.0'));
    expect(await readForkBaseVersion(root)).toBe('0.10.0');
    await mkdir(join(root, 'docs', 'release-notes', 'v1.0.0'));
    expect(await readForkBaseVersion(root)).toBe('1.0.0');
  });

  test('ignores non-strict versions and files, falling back to the Cargo base', async () => {
    const root = await source();
    expect(await readForkBaseVersion(root)).toBe('0.3.6');
    for (const name of ['v01.0.0', 'v9.0.0-beta.1', 'v9.0.0+meta', '9.0.0', 'v9.0', 'README.md']) {
      await mkdir(join(root, 'docs', 'release-notes', name), { recursive: true });
    }
    await writeFile(join(root, 'docs', 'release-notes', 'v99.0.0'), 'not a directory');
    expect(await readForkBaseVersion(root)).toBe('0.3.6');
    await mkdir(join(root, 'docs', 'release-notes', 'v0.3.50'));
    expect(await readForkBaseVersion(root)).toBe('0.3.50');
  });
});

describe('fork channel feeds', () => {
  test('advances numeric prereleases and base versions, never backwards', () => {
    for (const channel of ['fork', 'beta', 'dev']) {
      const manifest = (base: string, n: number) => ({ version: `${base}-${channel}.${n}` });
      expect(() => assertChannelAdvance(manifest('0.3.50', 9), manifest('0.3.50', 10))).not.toThrow();
      expect(() => assertChannelAdvance(manifest('0.3.50', 99), manifest('0.3.51', 1))).not.toThrow();
      expect(() => assertChannelAdvance(manifest('0.3.50', 10), manifest('0.3.50', 9))).toThrow();
      expect(() => assertChannelAdvance(manifest('0.3.50', 10), manifest('0.3.50', 10))).toThrow();
    }
  });

  test('rejects channel mixing and versions outside the fork scheme', () => {
    const previous = { version: '0.3.50-dev.9' };
    expect(() => assertChannelAdvance(previous, { version: '0.3.50-beta.10' })).toThrow();
    expect(() => assertChannelAdvance(previous, { version: '0.3.50+dev.10' })).toThrow();
  });
});
