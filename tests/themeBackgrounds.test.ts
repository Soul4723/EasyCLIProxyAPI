import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { themeTokenProperties } from '../src/themes/types';

const semanticPaint = new Set([
  'components/WindowFrame.css|.window-controls .window-close:hover',
  'components/WindowFrame.css|.window-controls .window-close:active',
  'styles/ui-refinements.css|.state-pill.success',
  'styles/ui-refinements.css|.state-pill.error',
  'styles/ui-refinements.css|.state-pill.warn',
  'styles/ui-refinements.css|.danger-button',
  'styles/ui-refinements.css|.danger-button:hover:not(:disabled)',
  "styles/ui-refinements.css|:root[data-theme='dark'] .danger-button",
  "styles/ui-refinements.css|:root[data-theme='dark'] .danger-button:hover:not(:disabled)",
  'styles.css|.agent-claude-code-disable-compact:has(input:checked)',
  'styles.css|.custom-mirror-dialog-list button:hover:not(:disabled)',
]);

const semanticPalettePaint = new Set([
  'styles/feature-pages.css|.easy-mode-hint',
  'styles/feature-pages.css|.simple-mode-step-status-item.complete .simple-mode-step-status-number',
  'styles/feature-pages.css|.simple-mode-step-status-connector.complete',
  'styles.css|.state-pill.success', 'styles.css|.state-pill.error',
  'styles.css|.state-pill.warning', 'styles.css|.state-pill.update',
  'styles.css|.app-release-notes-latest',
  'styles.css|.danger-button:hover:not(:disabled)',
  'styles.css|.icon-button.danger:hover:not(:disabled)',
  'styles.css|.close-dialog-error',
  'styles.css|.action-feedback.inline-notice',
  'styles.css|.action-feedback.inline-notice.error',
  'styles.css|.action-feedback.inline-notice.info',
  'styles.css|.model-discovery-inline-error',
  'styles.css|.agent-installed-indicator',
  'styles.css|.codex-session-progress-track i', 'styles.css|.codex-session-notice',
  'styles.css|.codex-session-notice.warning', 'styles.css|.codex-session-notice.error',
  'styles.css|.codex-session-meta > span',
  'styles.css|.install-dialog.success .install-progress-fill',
  'styles.css|.install-dialog.error .install-progress-fill',
  'styles.css|.inline-notice.success', 'styles.css|.inline-notice.error',
]);

test('component backgrounds use shared roles; literal paint is limited to semantic indicators', async () => {
  const source = fileURLToPath(new URL('../src/', import.meta.url));
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
