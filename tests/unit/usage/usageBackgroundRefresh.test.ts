import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('usage records background refresh', () => {
  it('allows default WebView background throttling', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    );
    const mainWindow = config.app.windows.find((window: { label?: string }) => window.label === 'main');
    const browserArgs = String(mainWindow?.additionalBrowserArgs ?? '').split(/\s+/);

    expect(mainWindow?.backgroundThrottling).not.toBe('disabled');
    expect(browserArgs).not.toContain('--disable-background-timer-throttling');
    expect(browserArgs).not.toContain('--disable-renderer-backgrounding');
    expect(browserArgs).not.toContain('--disable-backgrounding-occluded-windows');
  });
});
