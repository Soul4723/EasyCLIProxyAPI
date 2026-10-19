import { useCallback, useEffect, useMemo, useState } from 'react';
import { useResource } from '../../services/useResource';
import { invoke } from '../../services/usageApi';
import { Download, Inbox, SearchX, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { navigate } from '../../shell/router';
import { Button, DataTable, EmptyState, ErrorState, IconButton, Pagination, type DataTableColumn } from '../../ui';
import { RelativeTime } from '../../ui/RelativeTime';
import { FilterBar } from './FilterBar';
import { compactNumber } from './format';
import { RequestDrawer } from './RequestDrawer';
import { AccountCell, CostCell, LatencyCell, ModelCell, OutcomePill, TokensCell, useAgentLabel } from './RequestsCells';
import { exportFilteredEvents } from './RequestsExport';
import type { UsageEventPage, UsageRecord } from './types';
import { EVENT_PAGE_SIZES, useUsage } from './UsageContext';
import './Requests.css';

type Notice = { tone: 'ok' | 'danger'; text: string } | null;

/** Usage → Requests: filtered request log (newest first) with a detail drawer and CSV export. */
export function RequestsTab() {
  const { t } = useI18n();
  const agentLabel = useAgentLabel();
  const { query, page, setPage, pageSize, setPageSize, refreshVersion, activeFilterCount, resetFilters, setFilter, filters } = useUsage();
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<UsageRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const snapshot = useResource(() => invoke<UsageEventPage>('get_usage_events', {
    query: { ...query, page, page_size: pageSize },
  }), [query, page, pageSize, refreshVersion, retry]);
  const data = snapshot.data ?? null;
  const error = snapshot.error;
  const fetching = snapshot.refreshing;

  // The log shrank under the current page (filters, retention): fall back to the last page.
  useEffect(() => {
    if (data && data.totalPages > 0 && page > data.totalPages) setPage(data.totalPages);
  }, [data, page, setPage]);

  const total = data?.total ?? 0;

  const doExport = useCallback(async () => {
    setExporting(true);
    setNotice(null);
    try {
      const count = await exportFilteredEvents(query, { title: t('sec.usage.requests.exportDialogTitle'), fileType: t('sec.usage.requests.exportFileType') });
      if (count !== null) setNotice({ tone: 'ok', text: t('sec.usage.requests.exportDone', { count: compactNumber(count) }) });
    } catch (reason) {
      setNotice({ tone: 'danger', text: t('sec.usage.requests.exportFailed', { error: String(reason instanceof Error ? reason.message : reason) }) });
    } finally {
      setExporting(false);
    }
  }, [query, t]);

  const columns = useMemo<DataTableColumn<UsageRecord>[]>(() => [
    { id: 'time', header: t('sec.usage.requests.col.time'), width: 104, cell: (r) => <RelativeTime value={r.timestamp} className="ec-num" /> },
    { id: 'outcome', header: t('sec.usage.requests.col.outcome'), width: 108, cell: (r) => <OutcomePill record={r} /> },
    { id: 'model', header: t('sec.usage.requests.col.model'), width: 230, cell: (r) => <ModelCell record={r} /> },
    { id: 'account', header: t('sec.usage.requests.col.account'), cell: (r) => <AccountCell record={r} /> },
    { id: 'agent', header: t('sec.usage.requests.col.agent'), width: 96, cell: (r) => <span className="ec-trunc">{agentLabel(r.agent)}</span> },
    { id: 'tokens', header: t('sec.usage.requests.col.tokens'), width: 124, cell: (r) => <TokensCell record={r} /> },
    { id: 'latency', header: t('sec.usage.requests.col.latency'), width: 156, cell: (r) => <LatencyCell record={r} /> },
    { id: 'cost', header: t('sec.usage.requests.col.cost'), width: 112, align: 'end', cell: (r) => <CostCell record={r} /> },
  ], [t, agentLabel]);

  const initialLoading = data === null && error === null;
  const emptyState = activeFilterCount > 0 ? (
    <EmptyState icon={<SearchX size={20} />} title={t('sec.usage.requests.empty.noMatch')}
      action={<Button size="sm" variant="outline" icon={<X size={14} />} onClick={resetFilters}>{t('sec.usage.filter.reset')}</Button>} />
  ) : (
    <EmptyState icon={<Inbox size={20} />} title={t('sec.usage.requests.empty.none')}
      action={filters.range !== 'all'
        ? <Button size="sm" variant="outline" onClick={() => setFilter('range', 'all')}>{t('sec.usage.requests.empty.allTime')}</Button>
        : <Button size="sm" variant="outline" onClick={() => navigate('/overview')}>{t('sec.usage.requests.empty.action')}</Button>} />
  );

  return (
    <div className="req-tab">
      <FilterBar />
      <div className="req-toolbar">
        <span className="req-count" aria-live="polite">{data ? t('sec.usage.requests.count', { count: compactNumber(total) }) : ''}</span>
        {notice ? (
          <span className={`req-notice is-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>
            <span className="ec-trunc">{notice.text}</span>
            <IconButton label={t('sec.usage.requests.dismiss')} icon={<X size={12} />} size="xs" onClick={() => setNotice(null)} />
          </span>
        ) : null}
        <Button variant="outline" size="sm" icon={<Download size={14} />} loading={exporting} disabled={exporting || total === 0}
          title={total === 0 ? t('sec.usage.requests.exportNone') : undefined} onClick={() => void doExport()}>
          {exporting ? t('sec.usage.requests.exporting') : t('sec.usage.requests.export')}
        </Button>
      </div>

      {error && data ? <ErrorState title={t('sec.usage.error.load')} message={error} onRetry={() => setRetry((n) => n + 1)} retryLabel={t('sec.usage.retry')} /> : null}
      {error && data === null ? (
        <ErrorState title={t('sec.usage.error.load')} message={error} onRetry={() => { setRetry((n) => n + 1); }} retryLabel={t('sec.usage.retry')} />
      ) : (
        <div className={`req-table${fetching && data ? ' is-fetching' : ''}`} aria-busy={initialLoading}>
          <DataTable<UsageRecord>
            caption={t('sec.usage.requests.table')}
            columns={columns}
            rows={data?.items ?? []}
            rowKey={(r) => r.row_id}
            onRowClick={setSelected}
            selectedKey={selected?.row_id}
            loading={initialLoading}
            emptyState={emptyState}
          />
        </div>
      )}

      {data && total > 0 ? (
        <Pagination page={data.page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} pageSizes={[...EVENT_PAGE_SIZES]} />
      ) : null}

      <RequestDrawer record={selected} onClose={() => setSelected(null)} onFilterAccount={(authIndex) => setFilter('source', `auth:${authIndex}`)} />
    </div>
  );
}
