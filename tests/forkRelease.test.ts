import { describe, expect, test } from 'bun:test';
// @ts-expect-error build tooling is plain JavaScript
import { assertChannelAdvance } from '../scripts/fork-release.mjs';

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
