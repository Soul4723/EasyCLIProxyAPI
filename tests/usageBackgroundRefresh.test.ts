import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('usage records background refresh', () => {
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
