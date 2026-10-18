import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { managementApi } from '../../services/managementApi';
import { usagePreferences } from '../../services/usagePreferences';
import type { CollectorStatus, UsageAnalysis, UsageQuery, UsageRange } from './types';
import { rangeQuery } from './format';

const RANGE_KEY = 'cpa-gui.usage-records-range.v1';
const PAGE_SIZE_KEY = 'cpa-gui.usage-events-page-size.v1';
export const EVENT_PAGE_SIZES = [20, 50, 100, 200] as const;
const VALID_RANGES = ['4h', '24h', 'today', '7d', '30d', 'all', 'custom'];
export const emptyAnalysis: UsageAnalysis = { models: [], providers: [], sources: [], apiKeys: [] };

const loadRange = (): UsageRange => {
  try {
    const saved = usagePreferences.getItem(RANGE_KEY) ?? '';
    return VALID_RANGES.includes(saved) ? (saved as UsageRange) : '24h';
  } catch {
    return '24h';
  }
};
const loadPageSize = (): number => {
  try {
    const saved = Number(usagePreferences.getItem(PAGE_SIZE_KEY));
    return EVENT_PAGE_SIZES.includes(saved as (typeof EVENT_PAGE_SIZES)[number]) ? saved : 50;
  } catch {
    return 50;
  }
};

export type UsageFilters = {
  range: UsageRange;
  customStart: string;
  customEnd: string;
  model: string;
  agent: string;
  /** upstream key: `auth:<auth_index>` or `provider:<name>` */
  source: string;
  apiKeyHash: string;
  provider: string;
  result: 'all' | 'success' | 'failed' | 'canceled';
};

type UsageContextValue = {
  filters: UsageFilters;
  setFilter: <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => void;
  resetFilters: () => void;
  activeFilterCount: number;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  /** Time window only (no other filters). */
  timeQuery: Pick<UsageQuery, 'start' | 'end'>;
  /** Full filter query for overview/events/pricing. */
  query: UsageQuery;
  /** Stable string of `query` + range tick, for effect deps. */
  queryKey: string;
  status: CollectorStatus | null;
  setStatus: (status: CollectorStatus) => void;
  /** Filter option lists (models, upstream sources, keys) for the selected time window. */
  options: UsageAnalysis;
  /** Increments when the collector reports new records (event + 3s poll). Effects depend on it to refresh quietly. */
  tick: number;
  refresh: () => void;
};

const Ctx = createContext<UsageContextValue | null>(null);

export const useUsage = (): UsageContextValue => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useUsage must be used inside <UsageProvider>');
  return value;
};

const defaultFilters = (range: UsageRange): UsageFilters => ({
  range, customStart: '', customEnd: '', model: '', agent: '', source: '', apiKeyHash: '', provider: '', result: 'all',
});

/** ?account may be an auth file name (Quota links) or an auth_index; resolve a file name to its auth_index. */
async function resolveAccountSource(account: string): Promise<string> {
  try {
    const payload = await managementApi.get('/credentials') as { files?: Array<Record<string, unknown>> };
    const file = (payload.files ?? []).find((f) => f.name === account || f.auth_index === account || f.authIndex === account);
    const index = file?.auth_index ?? file?.authIndex;
    if (typeof index === 'string' && index) return `auth:${index}`;
    if (typeof index === 'number') return `auth:${index}`;
  } catch { /* keep the raw value */ }
  return `auth:${account}`;
}

/** `params` carries deep links: ?account=<auth file name | auth_index> ?provider=<p> ?model=<m> ?result=failed. */
export function UsageProvider({ params, children }: { params: URLSearchParams; children: ReactNode }) {
  const [filters, setFilters] = useState<UsageFilters>(() => {
    const base = defaultFilters(loadRange());
    const account = params.get('account');
    const result = params.get('result');
    return {
      ...base,
      source: account ? `auth:${account}` : '',
      provider: params.get('provider') ?? '',
      model: params.get('model') ?? '',
      result: result === 'failed' || result === 'success' || result === 'canceled' ? result : 'all',
    };
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(loadPageSize);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [options, setOptions] = useState<UsageAnalysis>(emptyAnalysis);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState(0);

  // Resolve a file-name account link to the collector's auth_index source key.
  const accountParam = params.get('account');
  useEffect(() => {
    if (!accountParam) return;
    let cancelled = false;
    resolveAccountSource(accountParam).then((source) => { if (!cancelled) setFilters((f) => (f.source === source ? f : { ...f, source })); });
    return () => { cancelled = true; };
  }, [accountParam]);

  // Deep links arriving while the page is open (same hash route, new query) re-apply their filters.
  const paramsKey = params.toString();
  const firstParams = useRef(paramsKey);
  useEffect(() => {
    if (firstParams.current === paramsKey) return;
    firstParams.current = paramsKey;
    const account = params.get('account');
    setFilters((f) => ({ ...f, source: account ? `auth:${account}` : f.source, provider: params.get('provider') ?? f.provider }));
    setPage(1);
  }, [paramsKey, params]);

  const setFilter = useCallback(<K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    if (key === 'range') {
      try { usagePreferences.setItem(RANGE_KEY, String(value)); } catch { /* preference only */ }
    }
  }, []);
  const resetFilters = useCallback(() => {
    setFilters((f) => defaultFilters(f.range));
    setPage(1);
  }, []);
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
    try { usagePreferences.setItem(PAGE_SIZE_KEY, String(size)); } catch { /* preference only */ }
  }, []);

  // `clock` re-evaluates relative windows (24h ends "now") on every refresh tick.
  const timeQuery = useMemo(
    () => rangeQuery(filters.range, filters.customStart, filters.customEnd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.range, filters.customStart, filters.customEnd, clock],
  );
  const query = useMemo<UsageQuery>(() => ({
    ...timeQuery,
    model: filters.model || undefined,
    agent: filters.agent || undefined,
    provider: filters.provider || undefined,
    upstream: filters.source || undefined,
    api_key_hash: filters.apiKeyHash || undefined,
    failed: filters.result === 'failed' ? true : filters.result === 'success' ? false : undefined,
    canceled: filters.result === 'canceled' ? true : filters.result === 'failed' ? false : undefined,
  }), [timeQuery, filters]);
  const queryKey = useMemo(() => JSON.stringify({ ...query, start: undefined, end: undefined, r: filters.range, cs: filters.customStart, ce: filters.customEnd }), [query, filters.range, filters.customStart, filters.customEnd]);

  const refresh = useCallback(() => { setTick((n) => n + 1); }, []);

  // Collector status + option lists refresh on every tick; options only matter for the time window.
  useEffect(() => {
    let cancelled = false;
    invoke<CollectorStatus>('get_usage_collector_status').then((next) => { if (!cancelled) setStatus(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [tick]);
  const optionsKey = JSON.stringify([filters.range, filters.customStart, filters.customEnd]);
  // Option lists re-fetch when the window changes and about every 10 ticks (~30s) otherwise.
  useEffect(() => {
    let cancelled = false;
    invoke<UsageAnalysis>('get_usage_analysis', { query: rangeQuery(filters.range, filters.customStart, filters.customEnd) })
      .then((next) => { if (!cancelled) setOptions(next); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, Math.floor(tick / 10)]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const bump = () => { if (!disposed) { setTick((n) => n + 1); setClock((n) => n + 1); } };
    listen('usage-records-updated', bump).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    const timer = window.setInterval(bump, 3_000);
    window.addEventListener('focus', bump);
    return () => { disposed = true; unlisten?.(); window.clearInterval(timer); window.removeEventListener('focus', bump); };
  }, []);

  const activeFilterCount = [filters.model, filters.agent, filters.source, filters.apiKeyHash, filters.provider, filters.result !== 'all' ? 'x' : ''].filter(Boolean).length;

  const value = useMemo<UsageContextValue>(() => ({
    filters, setFilter, resetFilters, activeFilterCount, page, setPage, pageSize, setPageSize,
    timeQuery, query, queryKey, status, setStatus, options, tick, refresh,
  }), [filters, setFilter, resetFilters, activeFilterCount, page, pageSize, setPageSize, timeQuery, query, queryKey, status, options, tick, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
