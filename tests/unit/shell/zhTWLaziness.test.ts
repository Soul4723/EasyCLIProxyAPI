import { describe, expect, it } from 'bun:test';
import { getZhTW, isZhTWBuilt, zhTWOverrides } from '../../../src/i18n/locales/zh-TW';
import { createTraditionalMessages } from '../../../src/i18n/locales/traditional';
import { zhTW } from '../../../src/i18n/resources';
import { zhCN } from '../../../src/i18n/locales/zh-CN';

describe('lazy Traditional Chinese locale', () => {
  it('does not build the locale at import and builds it once on first use', () => {
    expect(isZhTWBuilt()).toBe(false);

    const startedAt = performance.now();
    const first = getZhTW();
    const elapsedMs = performance.now() - startedAt;
    const second = getZhTW();

    expect(isZhTWBuilt()).toBe(true);
    expect(second).toBe(first);
    expect(first).toEqual({ ...createTraditionalMessages(zhCN), ...zhTWOverrides });
    expect(first['app.nav.authFiles']).toBe('憑證檔案');
    expect(first['authFiles.uploaded']).toBe('已上傳 {count} 個憑證檔案');
    expect(first['app.theme.triggerLabel']).toBe('外觀');
    expect(zhTW['authFiles.title']).toBe('憑證檔案');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 'app.nav.authFiles', 'changed')).toBe(false);
    expect(Reflect.set(zhTW, 'app.nav.authFiles', 'changed')).toBe(false);
    expect(getZhTW()['app.nav.authFiles']).toBe('憑證檔案');
    expect(zhTW['app.nav.authFiles']).toBe('憑證檔案');
    console.info(`[i18n] zh-TW first-build cost: ${elapsedMs.toFixed(2)} ms`);
  });
});
