import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const stylesheet = postcss.parse([
  '../src/styles/legacy-tokens.css',
  '../src/styles/base.css',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'));
const aliases: Record<string, string> = {
  '--theme-5f5a53': '--text-secondary',
  '--theme-6d6760': '--text-secondary',
  '--theme-777067': '--text-tertiary',
  '--theme-7a746c': '--text-tertiary',
  '--theme-817b72': '--text-tertiary',
  '--theme-8a847c': '--text-quaternary',
};
const surfaces = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--bg-card',
  '--theme-faf9f5', '--theme-fffdf8', '--theme-f4f1ea', '--theme-eeece6', '--theme-ece8df',
  '--theme-eef7f0', '--theme-fff1ee',
];
const textTokens = [
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-quaternary',
  '--text-placeholder', ...Object.keys(aliases),
];
type RGB = [number, number, number];

function declarations(selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  stylesheet.walkRules((rule) => {
    if (rule.selector.replace(/\r\n/g, '\n') !== selector) return;
    rule.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
  });
  return values;
}

function resolve(value: string, tokens: Record<string, string>, seen = new Set<string>()): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (!match) return value;
  const name = match[1];
  if (!tokens[name] || seen.has(name)) throw new Error(`Invalid color token: ${name}`);
  return resolve(tokens[name], tokens, new Set([...seen, name]));
}

function color(value: string, backdrop: RGB = [255, 255, 255]): RGB {
  if (/^#[\da-f]{3}$/i.test(value)) value = `#${[...value.slice(1)].map((digit) => digit.repeat(2)).join('')}`;
  if (/^#[\da-f]{6}$/i.test(value)) {
    return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as RGB;
  }
  const match = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`Unsupported color: ${value}`);
  const alpha = Number(match[4]);
  return backdrop.map((channel, index) => Number(match[index + 1]) * alpha + channel * (1 - alpha)) as RGB;
}

function luminance(rgb: RGB): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground: RGB, background: RGB): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  describe(`${theme} text contrast`, () => {
    const tokens = {
      ...declarations(':root'),
      ...(theme === 'dark' ? declarations(":root[data-theme='dark']") : {}),
    };
    const value = (token: string) => resolve(tokens[token], tokens);

    it('uses semantic colors for legacy gray text instead of separate low-contrast values', () => {
      for (const [alias, semantic] of Object.entries(aliases)) {
        expect(tokens[alias]).toBe(`var(${semantic})`);
        expect(value(alias)).toBe(value(semantic));
      }
    });

    it('keeps normal text and placeholders at 4.5:1 across application surfaces', () => {
      const failures: string[] = [];
      for (const base of ['--bg-card', '--bg-secondary']) {
        const backdrop = color(value(base));
        for (const surface of surfaces) {
          const background = color(value(surface), backdrop);
          for (const token of textTokens) {
            const ratio = contrast(color(value(token)), background);
            if (ratio < 4.5) failures.push(`${token} on ${surface} over ${base}: ${ratio.toFixed(3)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it('preserves background layers and reserves lower contrast for disabled text', () => {
      expect(value('--bg-primary')).toBe(theme === 'light' ? '#ffffff' : '#141720');
      expect(value('--bg-card')).toBe(theme === 'light' ? '#ffffff' : '#141720');
      expect(value('--bg-secondary')).toBe(theme === 'light' ? '#f6f7f5' : '#0b0d11');
      expect(value('--bg-tertiary')).toBe(theme === 'light' ? '#eff3f0' : '#1c212c');
      expect(value('--bg-hover')).toBe(theme === 'light' ? '#f6f8f6' : '#252b38');
      expect(value('--theme-faf9f5')).toBe(theme === 'light' ? '#f6f7f5' : '#0b0d11');
      const background = color(value('--bg-card'));
      const hierarchy = ['primary', 'secondary', 'tertiary', 'quaternary', 'disabled']
        .map((role) => contrast(color(value(`--text-${role}`)), background));
      for (let index = 1; index < hierarchy.length; index += 1) {
        expect(hierarchy[index - 1]).toBeGreaterThan(hierarchy[index]);
      }
    });
  });
}

it('renders placeholders at full opacity using the shared readable color', () => {
  expect(declarations('input::placeholder,\ntextarea::placeholder')).toMatchObject({
    color: 'var(--text-placeholder)', opacity: '1',
  });
});
