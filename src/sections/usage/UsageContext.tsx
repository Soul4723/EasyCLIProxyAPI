import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '../../services/usageApi';
import { useCoreRuntime } from '../../coreRuntime';
import { createDataSource, useDataSource, type DataSource } from '../../services/dataSource';
import { useResource } from '../../services/useResource';
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
  // This provider is the single owner; the native collector itself owns queue
  // draining and retry backoff (not a frontend poll).
  const statusSource = useMemo(() => createDataSource({
    load: () => invoke<CollectorStatus>('get_usage_collector_status'),
    pollMs: coreReady ? 30_000 : undefined,
    maxPollMs: 120_000, events: ['usage-records-updated'], eventDelayMs: 2_000, minIntervalMs: 2_000,
  }), [coreReady, connectionRevision]);
  const statusSnapshot = useDataSource(statusSource);
  const status = statusSnapshot.data ?? null;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [manualVersion, setManualVersion] = useState(0);
  const statusError = statusSnapshot.error ?? '';

  const setStatus = useCallback((next: CollectorStatus) => {
    statusSource.mutate(() => next);
    setRefreshVersion((n) => n + 1);
  }, [statusSource]);

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

  const invalidate = useCallback(() => {
    setRefreshVersion((n) => n + 1);
  }, []);
  const refresh = useCallback(() => {
    setManualVersion((n) => n + 1);
    invalidate();
  }, [invalidate]);

  // The page owns analysis reads. Identical option/breakdown queries share one promise,
  // including StrictMode and the no-filter Overview case. A signal starts a new snapshot.
  const analyses = useMemo(() => ({ refreshVersion, connectionRevision, timeQuery, requests: new Map<string, DataSource<UsageAnalysis>>() }), [refreshVersion, connectionRevision, timeQuery]);
  const loadAnalysis = useCallback((analysisQuery: UsageQuery) => {
    const key = JSON.stringify(analysisQuery);
    let request = analyses.requests.get(key);
    if (!request) {
      request = createDataSource({ load: () => invoke<UsageAnalysis>('get_usage_analysis', { query: analysisQuery }) });
      analyses.requests.set(key, request);
    }
    const source = request;
    return source.load().then(() => {
      const snapshot = source.getSnapshot();
      if (snapshot.error) { analyses.requests.delete(key); throw new Error(snapshot.error); }
      return snapshot.data!;
    });
  }, [analyses]);

  const optionSnapshot = useResource(async () => needsOptions ? loadAnalysis(timeQuery) : emptyAnalysis,
    [needsOptions, timeQuery, loadAnalysis]);
  const options = optionSnapshot.data ?? emptyAnalysis;
  const optionsError = optionSnapshot.error ?? '';

  const relative = filters.range !== 'custom' && filters.range !== 'all';
  // Separate the relative-range clock from event invalidation: records events
  // refresh the current query, but must not move its time window before 60s.
  const recordsSource = useMemo(() => createDataSource({
    load: async () => Date.now(),
    events: ['usage-records-updated'], eventDelayMs: 2_000, minIntervalMs: 2_000, focusMs: 30_000,
  }), [connectionRevision]);
  const clockSource = useMemo(() => createDataSource({
    load: async () => Date.now(),
    pollMs: relative && coreReady ? 60_000 : undefined, focusMs: Infinity,
  }), [relative, coreReady, connectionRevision]);
  const clockSnapshot = useDataSource(clockSource);
  const firstClock = useRef<{ source: typeof clockSource; value: number | undefined }>({ source: clockSource, value: undefined });
  useEffect(() => {
    if (firstClock.current.source !== clockSource || firstClock.current.value === undefined) {
      firstClock.current = { source: clockSource, value: clockSnapshot.data };
      return;
    }
    if (clockSnapshot.data !== undefined && clockSnapshot.data !== firstClock.current.value) {
      firstClock.current.value = clockSnapshot.data;
      setClock(clockSnapshot.data);
    }
  }, [clockSnapshot.data, clockSource]);
  const records = useDataSource(recordsSource);
  useEffect(() => {
    // A query/manual refresh already refreshed its views. Mark the focus owner
    // fresh without publishing a second records invalidation.
    const current = recordsSource.getSnapshot().data;
    if (current !== undefined) recordsSource.mutate(() => current);
  }, [query, manualVersion, recordsSource]);
  const firstRecord = useRef<{ source: typeof recordsSource; value: number | undefined }>({ source: recordsSource, value: undefined });
  useEffect(() => {
    if (firstRecord.current.source !== recordsSource || firstRecord.current.value === undefined) {
      firstRecord.current = { source: recordsSource, value: records.data };
      return;
    }
    if (records.data !== undefined && records.data !== firstRecord.current.value) {
      firstRecord.current.value = records.data;
      invalidate();
    }
  }, [records.data, recordsSource, invalidate]);
  const eventError = records.error ?? '';
  const statusRefresh = useRef(manualVersion);
  useEffect(() => {
    if (statusRefresh.current === manualVersion) return;
    statusRefresh.current = manualVersion;
    void statusSource.refresh();
  }, [manualVersion, statusSource]);

  const collection = useMemo(() => deriveCollectionState(status, coreStatus), [status, coreStatus]);
  const activeFilterCount = [filters.model, filters.agent, filters.source, filters.apiKeyHash, filters.provider, filters.result !== 'all' ? 'x' : ''].filter(Boolean).length;

  const value = useMemo<UsageContextValue>(() => ({
    filters, setFilter, resetFilters, activeFilterCount, page, setPage, pageSize, setPageSize,
    timeQuery, query, status, setStatus, collection, options, refreshVersion, refresh, manualVersion, loadAnalysis, error: [statusError, optionsError, eventError].filter(Boolean).join(" · "),
  }), [filters, setFilter, resetFilters, activeFilterCount, page, pageSize, setPageSize, timeQuery, query, status, setStatus, collection, options, refreshVersion, refresh, manualVersion, loadAnalysis, statusError, optionsError, eventError]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
