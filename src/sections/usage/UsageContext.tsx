import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke, onUsageRecordsUpdated } from '../../services/usageApi';
import { useCoreRuntime } from '../../coreRuntime';
import { managementApi } from '../../services/managementApi';
import { usagePreferences } from '../../services/usagePreferences';
import type { CollectorStatus, UsageAnalysis, UsageQuery, UsageRange } from './types';
import { rangeQuery } from './format';
import { deriveCollectionState, type CollectionState } from './collectionState';

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
  status: CollectorStatus | null;
  setStatus: (status: CollectorStatus) => void;
  /** Collector status combined with the shared core status: what the header may claim. */
  collection: CollectionState;
  /** Filter option lists (models, upstream sources, keys) for the selected time window. */
  options: UsageAnalysis;
  /** One invalidation version for records events and explicit refreshes. */
  refreshVersion: number;
  manualVersion: number;
  loadAnalysis: (query: UsageQuery) => Promise<UsageAnalysis>;
  error: string;
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
export function UsageProvider({ params, needsOptions, children }: { params: URLSearchParams; needsOptions: boolean; children: ReactNode }) {
  const { status: coreStatus, connectionRevision } = useCoreRuntime();
  const coreReady = coreStatus?.ready === true;
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
  const [status, setStatusState] = useState<CollectorStatus | null>(null);
  const statusRequest = useRef(0);
  const [options, setOptions] = useState<UsageAnalysis>(emptyAnalysis);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [manualVersion, setManualVersion] = useState(0);
  const [statusError, setStatusError] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [eventError, setEventError] = useState('');
  const lastRefresh = useRef(Date.now());

  const setStatus = useCallback((next: CollectorStatus) => {
    statusRequest.current += 1;
    setStatusState(next);
    setStatusError('');
    setRefreshVersion((n) => n + 1);
  }, []);

  // Resolve a file-name account link to the collector's auth_index source key.
  const accountParam = params.get('account');
  useEffect(() => {
    if (!accountParam) return;
    let cancelled = false;
    resolveAccountSource(accountParam).then((source) => { if (!cancelled) setFilters((f) => (f.source === source ? f : { ...f, source })); });
    return () => { cancelled = true; };
  }, [accountParam, manualVersion]);

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
      setClock(Date.now());
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

  const timeQuery = useMemo(
    () => rangeQuery(filters.range, filters.customStart, filters.customEnd, new Date(clock)),
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
  useEffect(() => { lastRefresh.current = Date.now(); }, [query]);

  const invalidate = useCallback(() => {
    lastRefresh.current = Date.now();
    setRefreshVersion((n) => n + 1);
  }, []);
  const refresh = useCallback(() => {
    setManualVersion((n) => n + 1);
    invalidate();
  }, [invalidate]);

  // The page owns analysis reads. Identical option/breakdown queries share one promise,
  // including StrictMode and the no-filter Overview case. A signal starts a new snapshot.
  const analyses = useMemo(() => ({ refreshVersion, connectionRevision, timeQuery, requests: new Map<string, Promise<UsageAnalysis>>() }), [refreshVersion, connectionRevision, timeQuery]);
  const loadAnalysis = useCallback((analysisQuery: UsageQuery) => {
    const key = JSON.stringify(analysisQuery);
    let request = analyses.requests.get(key);
    if (!request) {
      request = invoke<UsageAnalysis>('get_usage_analysis', { query: analysisQuery });
      analyses.requests.set(key, request);
      const current = request;
      void request.catch(() => { if (analyses.requests.get(key) === current) analyses.requests.delete(key); });
    }
    return request;
  }, [analyses]);

  useEffect(() => {
    if (!needsOptions) return;
    let cancelled = false;
    loadAnalysis(timeQuery).then((next) => {
      if (!cancelled) { setOptions(next); setOptionsError(''); }
    }, (error) => { if (!cancelled) setOptionsError(String(error)); });
    return () => { cancelled = true; };
  }, [needsOptions, timeQuery, loadAnalysis]);

  // Rust set_collector_status updates memory without emitting an event (pause/error
  // paths included). Poll only this small status while visible and the core is ready.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 30_000;
    const load = async () => {
      const id = ++statusRequest.current;
      clearTimeout(timer);
      try {
        const next = await invoke<CollectorStatus>('get_usage_collector_status');
        if (!cancelled && id === statusRequest.current) { setStatusState(next); setStatusError(''); delay = 30_000; }
      } catch (error) {
        if (!cancelled && id === statusRequest.current) { setStatusError(String(error)); delay = Math.min(delay * 2, 120_000); }
      }
      if (!cancelled && id === statusRequest.current && coreReady && !document.hidden) timer = setTimeout(load, delay);
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden && coreReady) timer = setTimeout(load, delay);
    };
    void load();
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; statusRequest.current += 1; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refreshVersion, coreReady, connectionRevision]);

  const relative = filters.range !== 'custom' && filters.range !== 'all';
  useEffect(() => {
    if (!relative || !coreReady) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        lastRefresh.current = Date.now();
        setClock(Date.now());
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [relative, coreReady]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Fixed trailing windows: a continuous stream cannot postpone refresh forever.
    const recordsUpdated = () => {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; if (!disposed) invalidate(); }, 2_000);
    };
    const focus = () => { if (!document.hidden && Date.now() - lastRefresh.current > 30_000) invalidate(); };
    onUsageRecordsUpdated(recordsUpdated).then((stop) => { if (disposed) stop(); else unlisten = stop; },
      (error) => { if (!disposed) setEventError(String(error)); });
    window.addEventListener('focus', focus);
    return () => { disposed = true; unlisten?.(); clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [invalidate]);

  const collection = useMemo(() => deriveCollectionState(status, coreStatus), [status, coreStatus]);
  const activeFilterCount = [filters.model, filters.agent, filters.source, filters.apiKeyHash, filters.provider, filters.result !== 'all' ? 'x' : ''].filter(Boolean).length;

  const value = useMemo<UsageContextValue>(() => ({
    filters, setFilter, resetFilters, activeFilterCount, page, setPage, pageSize, setPageSize,
    timeQuery, query, status, setStatus, collection, options, refreshVersion, refresh, manualVersion, loadAnalysis, error: [statusError, optionsError, eventError].filter(Boolean).join(" · "),
  }), [filters, setFilter, resetFilters, activeFilterCount, page, pageSize, setPageSize, timeQuery, query, status, setStatus, collection, options, refreshVersion, refresh, manualVersion, loadAnalysis, statusError, optionsError, eventError]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
