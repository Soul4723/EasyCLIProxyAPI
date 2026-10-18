import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../services/usageApi';
import { CheckCircle2, CircleAlert, CloudDownload, Pencil, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { getCurrentLocale, useI18n } from '../../i18n';
import {
  Button, Chip, ConfirmDialog, DataTable, EmptyState, ErrorState, IconButton, ProviderLogo, SearchInput, Skeleton, StatTile,
  providerInfo, type DataTableColumn,
} from '../../ui';
import { compactNumber, formatUsd } from './format';
import { draftFor, emptyDraft, PriceEditorDialog, PriceSyncDialog, type PriceDraft } from './PricesDialogs';
import type { UsagePriceRow, UsagePricing } from './types';
import { useUsage } from './UsageContext';
import './Prices.css';

type Notice = { tone: 'ok' | 'error'; text: string };

/** Model-name prefix → provider id, only to pick a logo; unknown models just get no logo. */
const MODEL_PROVIDERS: [RegExp, string][] = [
  [/^claude/i, 'claude'], [/^(gpt|o\d|codex|chatgpt)/i, 'codex'], [/^gemini/i, 'gemini'], [/^grok/i, 'xai'],
  [/^kimi/i, 'kimi'], [/^deepseek/i, 'deepseek'], [/^devin/i, 'devin'],
];
const modelProvider = (model: string) => MODEL_PROVIDERS.find(([pattern]) => pattern.test(model))?.[1] ?? null;

const formatUnit = (value: number) => {
  const digits = value >= 1 ? 2 : 4;
  return `$${new Intl.NumberFormat(getCurrentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value)}`;
};

/** Usage → Prices: estimated cost summary and the per-model price table (add / edit / delete / sync). */
export function PricesTab() {
  const { t } = useI18n();
  const { query, queryKey, tick, refresh } = useUsage();
  const [pricing, setPricing] = useState<UsagePricing | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [draftIsEdit, setDraftIsEdit] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);

  const queryRef = useRef(query);
  queryRef.current = query;
  const requestId = useRef(0);
  const noticeTimer = useRef<number | undefined>(undefined);

  // Quiet refresh: keeps the previous rows while refetching; only a failed first load shows the error state.
  useEffect(() => {
    const id = ++requestId.current;
    invoke<UsagePricing>('get_usage_pricing', { query: queryRef.current })
      .then((next) => { if (id === requestId.current) { setPricing(next); setLoadError(''); } })
      .catch((cause) => { if (id === requestId.current) setLoadError(String(cause)); });
  }, [queryKey, tick, reload]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const showNotice = useCallback((next: Notice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);
  const changed = useCallback(() => { setReload((n) => n + 1); refresh(); }, [refresh]);

  const unpricedCount = useMemo(
    () => pricing?.rows.filter((row) => row.price === null && row.requests > 0).length ?? 0,
    [pricing],
  );
  const rows = useMemo(() => {
    if (!pricing) return [];
    const keyword = search.trim().toLowerCase();
    return pricing.rows
      .filter((row) => (!keyword || row.model.toLowerCase().includes(keyword)) && (!unpricedOnly || row.price === null))
      .sort((a, b) => b.requests - a.requests);
  }, [pricing, search, unpricedOnly]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await invoke('delete_usage_model_price', { model: deleting });
      setDeleting(null);
      showNotice({ tone: 'ok', text: t('sec.usage.prices.deleted') });
      changed();
    } catch (cause) {
      setDeleting(null);
      showNotice({ tone: 'error', text: String(cause) });
    } finally {
      setDeleteBusy(false);
    }
  };

  const priceCell = (row: UsagePriceRow, field: 'prompt' | 'completion' | 'cacheRead' | 'cacheCreation') => {
    const price = row.price;
    const configured = price && price[`${field}Configured` as const];
    return configured ? <span className="ec-num">{formatUnit(price[field])}</span> : <span className="ec-muted">—</span>;
  };

  const columns: DataTableColumn<UsagePriceRow>[] = [
    {
      id: 'model', header: t('sec.usage.prices.col.model'), sortable: true, sortValue: (row) => row.model.toLowerCase(),
      cell: (row) => {
        const provider = modelProvider(row.model);
        return (
          <div className="prices-model">
            {provider ? <ProviderLogo provider={provider} size={18} title={providerInfo(provider).name} /> : <span className="prices-logo-gap" aria-hidden="true" />}
            <span className="ec-mono ec-trunc" title={row.model}>{row.model}</span>
            {row.price === null && row.requests > 0 ? <Chip size="sm" tone="warn" icon={<TriangleAlert />}>{t('sec.usage.prices.unpricedTag')}</Chip> : null}
          </div>
        );
      },
    },
    { id: 'requests', header: t('sec.usage.prices.col.requests'), align: 'end', sortable: true, sortValue: (row) => row.requests, cell: (row) => <span className="ec-num">{compactNumber(row.requests)}</span> },
    { id: 'tokens', header: t('sec.usage.prices.col.tokens'), align: 'end', sortable: true, sortValue: (row) => row.totalTokens, cell: (row) => <span className="ec-num">{compactNumber(row.totalTokens)}</span> },
    {
      id: 'cost', header: t('sec.usage.prices.col.cost'), align: 'end', sortable: true, sortValue: (row) => (row.price ? row.estimatedCost : null),
      cell: (row) => (row.price ? <strong className="ec-num">~{formatUsd(row.estimatedCost)}</strong> : <span className="ec-muted">—</span>),
    },
    { id: 'prompt', header: t('sec.usage.prices.col.prompt'), align: 'end', sortable: true, sortValue: (row) => (row.price?.promptConfigured ? row.price.prompt : null), cell: (row) => priceCell(row, 'prompt') },
    { id: 'completion', header: t('sec.usage.prices.col.completion'), align: 'end', sortable: true, sortValue: (row) => (row.price?.completionConfigured ? row.price.completion : null), cell: (row) => priceCell(row, 'completion') },
    { id: 'cacheRead', header: t('sec.usage.prices.col.cacheRead'), align: 'end', cell: (row) => priceCell(row, 'cacheRead') },
    { id: 'cacheWrite', header: t('sec.usage.prices.col.cacheWrite'), align: 'end', cell: (row) => priceCell(row, 'cacheCreation') },
    {
      id: 'source', header: t('sec.usage.prices.col.source'),
      cell: (row) => {
        if (!row.price) return <span className="ec-muted">—</span>;
        const source = row.price.source;
        if (source === 'manual') return <Chip size="sm" tone="accent">{t('sec.usage.prices.source.manual')}</Chip>;
        if (source === 'builtin' || source === 'built-in' || !source) return <Chip size="sm">{t('sec.usage.prices.source.builtin')}</Chip>;
        return <Chip size="sm">{source === 'models-dev' ? 'Models.dev' : source === 'litellm' ? 'LiteLLM' : source}</Chip>;
      },
    },
    {
      id: 'actions', header: <span className="prices-sr">{t('sec.usage.prices.col.actions')}</span>, align: 'end',
      cell: (row) => {
        const manual = row.price?.source === 'manual';
        return (
          <div className="prices-actions">
            <IconButton size="sm" icon={<Pencil />} label={t('sec.usage.prices.edit', { model: row.model })}
              onClick={() => { setDraftIsEdit(true); setDraft(draftFor(row.model, row.price)); }} />
            <IconButton size="sm" icon={<Trash2 />} disabled={!manual}
              label={manual ? t('sec.usage.prices.delete', { model: row.model }) : t('sec.usage.prices.deleteLocked')}
              onClick={() => setDeleting(row.model)} />
          </div>
        );
      },
    },
  ];

  const openAdd = () => { setDraftIsEdit(false); setDraft(emptyDraft()); };

  if (!pricing && loadError) {
    return <ErrorState title={t('sec.usage.error.load')} message={loadError} onRetry={changed} retryLabel={t('sec.usage.retry')} />;
  }
  if (!pricing) {
    return (
      <div className="prices-tab" aria-busy="true">
        <div className="prices-stats">{[0, 1, 2, 3].map((n) => <Skeleton key={n} height={74} radius="var(--ec-r-md)" />)}</div>
        <Skeleton height={36} />
        <Skeleton lines={6} height={30} />
      </div>
    );
  }

  const coverage = pricing.totalRequests > 0 ? Math.round((pricing.pricedRequests / pricing.totalRequests) * 100) : 0;
  const addButton = <Button variant="primary" size="sm" icon={<Plus />} onClick={openAdd}>{t('sec.usage.prices.add')}</Button>;

  return (
    <div className="prices-tab">
      <div className="prices-stats">
        <StatTile label={t('sec.usage.prices.stat.cost')} value={`~${formatUsd(pricing.totalCost)}`} accent="var(--ec-s1)" />
        <StatTile label={t('sec.usage.prices.stat.requests')} value={compactNumber(pricing.totalRequests)} accent="var(--ec-s2)" />
        <StatTile
          label={t('sec.usage.prices.stat.priced')}
          value={<>{compactNumber(pricing.pricedRequests)}<span className="prices-of"> / {compactNumber(pricing.totalRequests)}</span></>}
          hint={t('sec.usage.prices.stat.pricedHint', { pct: coverage })}
          accent="var(--ec-ok)"
        />
        <StatTile label={t('sec.usage.prices.stat.saved')} value={compactNumber(pricing.savedPrices)} accent="var(--ec-s3)" />
      </div>

      <div className="prices-toolbar">
        <div className="prices-search">
          <SearchInput value={search} onChange={setSearch} placeholder={t('sec.usage.prices.search')} />
        </div>
        {unpricedCount > 0 ? (
          <button type="button" className="prices-unpriced" aria-pressed={unpricedOnly} title={t('sec.usage.prices.unpricedOnly')} onClick={() => setUnpricedOnly((v) => !v)}>
            <Chip tone="warn" icon={<TriangleAlert />}>{t('sec.usage.prices.unpriced', { count: unpricedCount })}</Chip>
          </button>
        ) : null}
        <span className="prices-spacer" />
        <Button variant="secondary" size="sm" icon={<Plus />} onClick={openAdd}>{t('sec.usage.prices.add')}</Button>
        <Button variant="primary" size="sm" icon={<CloudDownload />} onClick={() => setSyncOpen(true)}>{t('sec.usage.prices.sync')}</Button>
      </div>

      {notice ? (
        <div className={`prices-notice prices-notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'ok' ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
          <span>{notice.text}</span>
          <IconButton size="xs" icon={<X />} label={t('sec.usage.prices.dismiss')} onClick={() => setNotice(null)} />
        </div>
      ) : null}

      {pricing.rows.length === 0 ? (
        <EmptyState icon={<CircleAlert size={20} />} title={t('sec.usage.prices.empty')} action={addButton} />
      ) : (
        <DataTable
          className="prices-table"
          caption={t('sec.usage.prices.tableLabel')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.model}
          stickyHeader
          emptyState={(
            <EmptyState compact title={t('sec.usage.prices.noMatch')}
              action={<Button size="xs" variant="outline" onClick={() => { setSearch(''); setUnpricedOnly(false); }}>{t('sec.usage.prices.showAll')}</Button>} />
          )}
        />
      )}

      <PriceEditorDialog
        draft={draft}
        isEdit={draftIsEdit}
        onClose={() => setDraft(null)}
        onSaved={() => { setDraft(null); showNotice({ tone: 'ok', text: t('sec.usage.prices.saved') }); changed(); }}
      />
      <PriceSyncDialog
        open={syncOpen}
        query={query}
        rows={pricing.rows}
        onClose={() => setSyncOpen(false)}
        onApplied={(imported) => { setSyncOpen(false); showNotice({ tone: 'ok', text: t('sec.usage.prices.sync.result', { imported }) }); changed(); }}
      />
      <ConfirmDialog
        open={deleting !== null}
        danger
        busy={deleteBusy}
        title={t('sec.usage.prices.deleteTitle')}
        message={t('sec.usage.prices.deleteMessage', { model: deleting ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
