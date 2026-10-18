import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('usage records background refresh', () => {
  it('keeps refresh triggers active when the document is hidden', () => {
    const source = readFileSync(new URL('../src/sections/usage/UsageContext.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const bump = () =>');
    const end = source.indexOf("window.addEventListener('focus', bump)", start);
    const block = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain("onUsageRecordsUpdated(bump)");
    expect(block).toContain('window.setInterval(bump');
    expect(block).not.toContain('document.hidden');
  });

  it('disables WebView background suspension for the desktop window', () => {
    const config = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    );
    const mainWindow = config.app.windows.find((window: { label?: string }) => window.label === 'main');
    const browserArgs = String(mainWindow?.additionalBrowserArgs ?? '').split(/\s+/);

    expect(mainWindow?.backgroundThrottling).toBe('disabled');
    expect(browserArgs).toContain('--disable-background-timer-throttling');
    expect(browserArgs).toContain('--disable-renderer-backgrounding');
    expect(browserArgs).toContain('--disable-backgrounding-occluded-windows');
  });
});
