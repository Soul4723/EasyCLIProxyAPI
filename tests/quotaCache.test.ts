import { describe, expect, it } from 'bun:test';
import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  invalidateQuotaCache,
  getQuotaCacheSnapshot,
  pruneQuotaCache,
  updateQuotaCache,
} from '../src/services/quotaCache';

describe('额度跨页面缓存', () => {
  it('保留仍存在的认证文件额度并清理失效项', () => {
    updateQuotaCache({
      first: { status: 'success', rows: [], fetchedAt: 1 },
      removed: { status: 'error', rows: [], error: 'old' },
    });
    pruneQuotaCache(new Set(['first']));

    expect(getQuotaCacheSnapshot()).toEqual({
      first: { status: 'success', rows: [], fetchedAt: 1 },
    });
  });

  it('认证文件集合变化后拒绝过期请求写回', () => {
    updateQuotaCache({
      stale: { status: 'loading', rows: [] },
      retained: { status: 'loading', rows: [] },
    });
    const generation = captureQuotaCacheGeneration();
    pruneQuotaCache(new Set(['retained']));
    let committed = false;

    expect(commitQuotaCacheIfCurrent(generation, () => {
      committed = true;
    })).toBe(false);
    expect(committed).toBe(false);
    expect(getQuotaCacheSnapshot().retained).toEqual({ status: 'idle', rows: [] });
  });

  it('目标切换清空旧目标数据并拒绝旧请求写回', () => {
    updateQuotaCache({ shared: { status: 'success', rows: [], fetchedAt: 1 } });
    const generation = captureQuotaCacheGeneration();
    invalidateQuotaCache();
    let committed = false;
    expect(commitQuotaCacheIfCurrent(generation, () => { committed = true; })).toBe(false);
    expect(committed).toBe(false);
    expect(getQuotaCacheSnapshot()).toEqual({});
  });
});
