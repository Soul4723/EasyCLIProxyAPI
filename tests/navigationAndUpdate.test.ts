import { describe, expect, test } from 'bun:test';
import { appUpdateIndicatorState } from '../src/appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from '../src/navigation';

describe('简易模式、首页、配置与版本管理导航', () => {
  test('内核停止时简易模式、概览、设置、用量、代理与套件始终可进入', () => {
    for (const page of ['easy', 'overview', 'settings', 'usage', 'agents', 'kit']) {
      expect(isAlwaysAvailablePage(page)).toBe(true);
      expect(canOpenAppPage(page, false)).toBe(true);
    }
    for (const page of ['home', 'versions', 'config', 'usage-records', 'quota']) {
      expect(isAlwaysAvailablePage(page)).toBe(false);
      expect(canOpenAppPage(page, false)).toBe(false);
    }
  });

  test('内核运行后解锁其他功能页', () => {
    expect(canOpenAppPage('config', true)).toBe(true);
    expect(canOpenAppPage('agents', true)).toBe(true);
    expect(canOpenAppPage('quota', true)).toBe(true);
  });
});

describe('软件与内核更新导航提示点', () => {
  test('任一组件有新版都显示橙点，处理中的蓝点优先', () => {
    expect(appUpdateIndicatorState(true, false, false)).toBe('available');
    expect(appUpdateIndicatorState(false, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, true, false)).toBe('available');
    expect(appUpdateIndicatorState(true, false, true)).toBe('processing');
    expect(appUpdateIndicatorState(false, true, true)).toBe('processing');
  });

  test('最新版或检查失败都不显示提示点', () => {
    expect(appUpdateIndicatorState(false, false, false)).toBeNull();
  });
});
