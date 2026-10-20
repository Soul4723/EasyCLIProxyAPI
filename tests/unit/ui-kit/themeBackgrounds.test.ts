import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { themeTokenProperties } from '../../../src/themes/types';

const semanticPaint = new Set([
  'styles/controls.css|.danger-button',
  'styles/controls.css|.danger-button:hover:not(:disabled)',
  "styles/controls.css|:root[data-theme='dark'] .danger-button",
  "styles/controls.css|:root[data-theme='dark'] .danger-button:hover:not(:disabled)",
]);

const semanticPalettePaint = new Set([
  'components/AppReleaseNotes.css|.app-release-notes-latest',
  'styles/controls.css|.danger-button:hover:not(:disabled)',
  'styles/controls.css|.icon-button.danger:hover:not(:disabled)',
  'appNotice.css|.action-feedback.inline-notice',
  'appNotice.css|.action-feedback.inline-notice.error',
  'appNotice.css|.action-feedback.inline-notice.info',
  'appUpdate.css|.install-dialog.success .install-progress-fill',
  'appUpdate.css|.install-dialog.error .install-progress-fill',
  'appNotice.css|.inline-notice.success', 'appNotice.css|.inline-notice.error',
]);

test('component backgrounds use shared roles; literal paint is limited to semantic indicators', async () => {
  const source = fileURLToPath(new URL('../../../src/', import.meta.url));
  const violations: string[] = [];
  const themeRoles = new Set<string>(Object.values(themeTokenProperties).flat());
  const adaptiveLegacyColors = new Set(['--theme-8a847c', '--theme-7a746c']);
  for await (const path of new Bun.Glob('**/*.css').scan(source)) {
    if (path.startsWith('mocks/')) continue;
    const css = (await readFile(`${source}${path}`, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const [, property, value] of body.matchAll(/(?:^|;)\s*(background(?:-color|-image)?)\s*:\s*([^;]+)/g)) {
        const key = `${path}|${selector.trim().replace(/\s+/g, ' ')}`;
        for (const [, dependency] of value.matchAll(/var\((--theme-[a-f\d]{3,6})(?=[,)])/g)) {
          if (!themeRoles.has(dependency) && !adaptiveLegacyColors.has(dependency) && !semanticPalettePaint.has(key)) {
            violations.push(`${key}: unthemed background variable ${dependency}`);
          }
        }
        let paint = value;
        while (paint.includes('var(')) {
          const start = paint.indexOf('var(');
          let end = start + 4;
          let depth = 1;
          while (end < paint.length && depth) {
            if (paint[end] === '(') depth++;
            if (paint[end] === ')') depth--;
            end++;
          }
          paint = `${paint.slice(0, start)}token${paint.slice(end)}`;
        }
        if (!/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black)\b/i.test(paint)) continue;
        if (!semanticPaint.has(key)) violations.push(`${key}: ${property}: ${value.trim()}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
