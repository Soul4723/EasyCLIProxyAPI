import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GalleryVertical, Gauge, LayoutGrid, Rows3, RefreshCw, GanttChart, X } from 'lucide-react';
import {
  Button, EmptyState, ErrorState, FilterChips, IconButton, ProviderLogo, SearchInput, SegmentedControl, Skeleton,
  providerInfo,
} from '../../ui';
import { useI18n } from '../../i18n';
import { useDensity } from '../../density';
import { PageHeader } from '../../shell/PageHeader';
import { routeHref, useRoute } from '../../shell/router';
import type { SectionPageProps } from '../../shell/types';
import { AccountCard, AccountRow, RowsHeader } from './AccountItem';
import { AccountPanel } from './AccountPanel';
import type { ControlsContext, QuotaActions } from './AccountControls';
import { GroupHeader } from './GroupHeader';
import { LightningPopover } from './LightningPopover';
import { TimelineView } from './TimelineView';
import { groupAccounts, matchesSearch, PROVIDER_ORDER, type QuotaAccount } from './model';
import { useConfirmAsk } from './useConfirmAsk';
import { useLighting } from './useLighting';
import { useQuotaData } from './useQuotaData';
import './quota.css';

type View = 'providers' | 'grid' | 'timeline';
type Layout = 'cards' | 'rows';
const VIEW_KEY = 'easy-cli-proxy-api.quota.view';
const LAYOUT_KEY = 'easy-cli-proxy-api.quota.layout';

function readStored<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : null;
  } catch { return null; }
}
const store = (key: string, value: string | null) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* ignore */ }
};

const NARROW = '(max-width: 860px)';
function useNarrow() {
  return useSyncExternalStore(
    (listener) => { const query = window.matchMedia(NARROW); query.addEventListener('change', listener); return () => query.removeEventListener('change', listener); },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

export function QuotaSection({ params }: SectionPageProps) {
  const { t, formatNumber } = useI18n();
  const route = useRoute();
  const [density] = useDensity();
  const narrow = useNarrow();
  const { ask, dialog } = useConfirmAsk();
  const { locale } = useI18n();
  const lighting = useLighting(locale);
  const data = useQuotaData({
    askConfirmation: ask,
    onFetched: (account, quota) => lighting.reportObserved(account, quota),
  });
  const { accounts, now } = data;

  const [view, setViewState] = useState<View>(() => readStored<View>(VIEW_KEY, ['providers', 'grid', 'timeline']) ?? 'providers');
  const [layoutPref, setLayoutPref] = useState<Layout | null>(() => readStored<Layout>(LAYOUT_KEY, ['cards', 'rows']));
  const layout: Layout = narrow ? 'cards' : layoutPref ?? (density === 'compact' ? 'rows' : 'cards');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [provider, setProvider] = useState<string>(params.get('provider') ?? 'all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [lightingKey, setLightingKey] = useState<string | null>(null);
  const lightingAnchor = useRef<HTMLElement | null>(null);

  const setView = (next: View) => { setViewState(next); store(VIEW_KEY, next); };
  const setLayout = (next: Layout) => { setLayoutPref(next); store(LAYOUT_KEY, next); };

  // Deep link: #/quota?cred=<file name> opens that account's detail once the list is loaded.
  const deepLinked = useRef<string | null>(null);
  useEffect(() => {
    const cred = params.get('cred');
    if (!cred || deepLinked.current === cred || !accounts.length) return;
    const match = accounts.find((account) => account.fileName === cred);
    deepLinked.current = cred;
    if (match) setSelectedKey(match.key);
  }, [params, accounts, route.path]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    accounts.forEach((account) => map.set(account.provider, (map.get(account.provider) ?? 0) + 1));
    return map;
  }, [accounts]);

  const visible = useMemo(() => accounts.filter((account) =>
    (provider === 'all' || account.provider === provider) && matchesSearch(account, query)), [accounts, provider, query]);
  const groups = useMemo(() => groupAccounts(visible), [visible]);
  const selected = accounts.find((account) => account.key === selectedKey) ?? null;
  const lightingAccount = accounts.find((account) => account.key === lightingKey) ?? null;

  const actions: QuotaActions = useMemo(() => ({
    open: (account) => setSelectedKey(account.key),
    refresh: (account) => { void data.refreshOne(account); },
    setEnabled: (account, enabled) => { void data.setEnabled(account, enabled); },
    consume: (account) => { void data.resetQuota(account); },
    clearCooldown: (account) => { void data.clearCooldown(account); },
    openLighting: (account, anchor) => { lightingAnchor.current = anchor; setLightingKey(account.key); },
  // data's action callbacks are stable except where they read busyKeys; rebuild when those change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [data.refreshOne, data.setEnabled, data.resetQuota, data.clearCooldown]);

  const ctx: ControlsContext = { now, lighting, actions, busyKeys: data.busyKeys };

  const providerOptions = [
    { value: 'all', label: t('sec.quota.filter.all'), count: accounts.length },
    ...PROVIDER_ORDER.filter((id) => counts.has(id)).map((id) => ({
      value: id,
      label: providerInfo(id).name,
      count: counts.get(id),
      color: `var(${providerInfo(id).colorVar.replace(/^var\(|\)$/g, '')})`,
      icon: <ProviderLogo provider={id} size={14} />,
    })),
  ];

  const renderItems = (list: QuotaAccount[]) => layout === 'rows' ? (
    <div className="qt-rows">
      <RowsHeader />
      {list.map((account) => <AccountRow key={account.key} account={account} ctx={ctx} selected={selected?.key === account.key} />)}
    </div>
  ) : (
    <div className="qt-grid">
      {list.map((account) => <AccountCard key={account.key} account={account} ctx={ctx} selected={selected?.key === account.key} />)}
    </div>
  );

  const toggleGroup = useCallback((id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  const headerActions = (
    <>
      <SegmentedControl<View>
        ariaLabel={t('sec.quota.view')}
        size="sm"
        value={view}
        onChange={setView}
        options={[
          { value: 'providers', label: t('sec.quota.view.providers'), icon: <GalleryVertical size={13} /> },
          { value: 'grid', label: t('sec.quota.view.grid'), icon: <LayoutGrid size={13} /> },
          { value: 'timeline', label: t('sec.quota.view.timeline'), icon: <GanttChart size={13} /> },
        ]}
      />
      {view !== 'timeline' && !narrow ? (
        <IconButton
          label={layout === 'rows' ? t('sec.quota.layout.cards') : t('sec.quota.layout.rows')}
          icon={layout === 'rows' ? <LayoutGrid size={15} /> : <Rows3 size={15} />}
          onClick={() => setLayout(layout === 'rows' ? 'cards' : 'rows')}
        />
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        icon={<RefreshCw size={14} className={data.anyLoading ? 'qt-spin' : undefined} />}
        disabled={data.anyLoading || !accounts.some((account) => account.canFetch)}
        onClick={() => void data.refreshAll()}
      >{t('sec.quota.refreshAll')}</Button>
    </>
  );

  let content;
  if (data.loading && accounts.length === 0) {
    content = <div className="qt-grid" aria-busy="true">{[0, 1, 2].map((index) => <div key={index} className="qt-card"><Skeleton lines={4} height={14} /></div>)}</div>;
  } else if (data.loadError && accounts.length === 0) {
    content = <ErrorState message={data.loadError} onRetry={() => void data.reload()} />;
  } else if (accounts.length === 0) {
    content = (
      <EmptyState
        icon={<Gauge size={20} />}
        title={t('sec.quota.empty')}
        action={<a href={routeHref('providers')}><Button size="sm" variant="primary">{t('sec.quota.empty.action')}</Button></a>}
      />
    );
  } else if (visible.length === 0) {
    content = (
      <EmptyState
        title={t('sec.quota.noMatch')}
        action={<Button size="sm" variant="outline" onClick={() => { setQuery(''); setProvider('all'); }}>{t('sec.quota.clearFilters')}</Button>}
      />
    );
  } else if (view === 'timeline') {
    content = <TimelineView accounts={visible} ctx={ctx} selectedKey={selected?.key ?? null} />;
  } else if (view === 'grid') {
    content = renderItems(groups.flatMap((group) => group.accounts));
  } else {
    content = (
      <div className="qt-groups">
        {groups.map((group) => (
          <section key={group.provider} className="qt-group" data-provider={group.provider}>
            <GroupHeader
              group={group}
              now={now}
              collapsed={collapsed.has(group.provider)}
              onToggle={() => toggleGroup(group.provider)}
              onPick={(account) => setSelectedKey(account.key)}
            />
            {collapsed.has(group.provider) ? null : renderItems(group.accounts)}
          </section>
        ))}
      </div>
    );
  }

  const message = data.actionError || data.notice;
  return (
    <div className="ec-sec-quota">
      <PageHeader title={t('sec.quota.title')} count={accounts.length || undefined} actions={headerActions} />
      <div className="ec-page-body">
        {message ? (
          <div className={`qt-banner${data.actionError ? ' qt-banner--bad' : ''}`} role={data.actionError ? 'alert' : 'status'}>
            <span>{message}</span>
            <IconButton size="xs" label={t('sec.quota.dismiss')} icon={<X size={12} />} onClick={() => { data.setActionError(''); data.setNotice(''); }} />
          </div>
        ) : null}
        {accounts.length > 0 ? (
          <div className="qt-toolbar">
            <FilterChips value={provider} onChange={setProvider} options={providerOptions} ariaLabel={t('sec.quota.filter.label')} />
            <div className="qt-toolbar__search">
              <SearchInput value={query} onChange={setQuery} placeholder={t('sec.quota.search')} ariaLabel={t('sec.quota.search')} />
            </div>
          </div>
        ) : null}
        {content}
        <span className="ec-sr-only" aria-live="polite">{accounts.length ? t('sec.quota.count', { count: formatNumber(visible.length) }) : ''}</span>
      </div>

      <AccountPanel account={selected} ctx={ctx} onClose={() => setSelectedKey(null)} />
      {lightingAccount ? (
        <LightningPopover
          account={lightingAccount}
          anchorRef={lightingAnchor}
          open
          onClose={() => setLightingKey(null)}
          lighting={lighting}
          now={now}
          onSaved={() => lighting.reportObserved(lightingAccount, lightingAccount.quota)}
        />
      ) : null}
      {dialog}
    </div>
  );
}
