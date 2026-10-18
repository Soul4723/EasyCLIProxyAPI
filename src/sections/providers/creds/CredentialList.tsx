import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowUpRight, Boxes, Copy, FileDown, MoreHorizontal, Power, RotateCcw, Settings2, Trash2 } from 'lucide-react';
import { useDensity } from '../../../density';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { routeHref } from '../../../shell/router';
import { authFileCooldownResetIndex } from '../../../services/authFiles';
import { normalizeAuthFileCooldowns } from '../../../services/authFileHealth';
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  Pagination,
  Popover,
  PopoverItem,
  PopoverSeparator,
  type DataTableColumn,
  type SortState,
} from '../../../ui';
import { STATUS_ORDER } from '../../../ui/StatusPill';
import { filterCredentials, type CredentialRow, type CredentialStatusFilter } from './model';
import { CredentialIdentity, CredentialStatusCell, RequestBar } from './parts';
import type { CredentialsCore } from './useCredentials';
import './creds.css';

export type CredentialListProps = {
  controller: CredentialsCore;
  /** Brand id to show only that provider's credentials. */
  provider?: string;
  query?: string;
  status?: CredentialStatusFilter;
  pageSize?: number;
  /** Show the provider logo (turn off on a single-provider page). Default true. */
  showProvider?: boolean;
};

const hasCooldownRecords = (row: CredentialRow) =>
  Boolean(authFileCooldownResetIndex(row.file) && normalizeAuthFileCooldowns(row.file.cooldowns, 0)?.records?.length);

function RowMenu({ row, controller }: { row: CredentialRow; controller: CredentialsCore }) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const name = mask.text(row.name, row.identities);
  const run = (action: () => void) => () => { close(); action(); };
  return (
    <>
      <IconButton ref={anchor} size="sm" label={`${t('authFiles.list.actions')}: ${name}`} icon={<MoreHorizontal size={16} />}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
      <Popover open={open} onClose={close} anchorRef={anchor} align="end" width={220} label={t('authFiles.list.actions')}>
        <PopoverItem icon={<Settings2 size={14} />} disabled={!row.editable} onClick={run(() => controller.select(row.name, 'routing'))}>
          {t('authFiles.settings.button')}
        </PopoverItem>
        <PopoverItem icon={<Boxes size={14} />} onClick={run(() => controller.select(row.name, 'models'))}>
          {t('authFiles.models.button')}
        </PopoverItem>
        <PopoverItem icon={<Copy size={14} />} onClick={run(() => void controller.copyName(row))}>
          {t('authFiles.copyName')}
        </PopoverItem>
        {/* Quota is the one home for enable/disable; credentials it does not list keep the switch here. */}
        {!row.quotaProvider ? (
          <PopoverItem icon={<Power size={14} />} disabled={controller.busy || !row.editable} onClick={run(() => void controller.toggle(row))}>
            {t(row.disabled ? 'common.enable' : 'common.disable')}
          </PopoverItem>
        ) : null}
        {hasCooldownRecords(row) ? (
          <PopoverItem icon={<RotateCcw size={14} />} disabled={controller.busy} onClick={run(() => controller.clearCooldown(row))}>
            {t('authFiles.cooldown.resetButton')}
          </PopoverItem>
        ) : null}
        <PopoverSeparator />
        <PopoverItem icon={<Trash2 size={14} />} danger disabled={controller.busy || row.runtimeOnly} onClick={run(() => controller.remove(row))}>
          {row.runtimeOnly ? t('sec.providers.creds.delete.runtime') : t('common.delete')}
        </PopoverItem>
      </Popover>
    </>
  );
}

export function CredentialList({ controller, provider, query, status, pageSize: initialPageSize = 10, showProvider = true }: CredentialListProps) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [density] = useDensity();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [sort, setSort] = useState<SortState | undefined>(undefined);

  const filtered = useMemo(
    () => filterCredentials(controller.rows, { provider, query, status }),
    [controller.rows, provider, query, status],
  );
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const sign = sort.dir === 'asc' ? 1 : -1;
    const value = (row: CredentialRow): string | number => {
      if (sort.id === 'status') return STATUS_ORDER.indexOf(row.status);
      if (sort.id === 'priority') return row.priority;
      if (sort.id === 'requests') return (row.requests?.ok ?? -1) + (row.requests?.fail ?? 0);
      return (row.identity || row.name).toLowerCase();
    };
    return [...filtered].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * sign;
    });
  }, [filtered, sort]);

  useEffect(() => setPage(1), [provider, query, status, pageSize]);
  // A newly selected credential (row click, menu, deep link) is brought onto its page and into view once.
  const shownSelection = useRef<string | null>(null);
  useEffect(() => {
    const name = controller.selectedName;
    if (!name) { shownSelection.current = null; return; }
    if (shownSelection.current === name) return;
    const index = sorted.findIndex((row) => row.name === name);
    if (index < 0) return;
    shownSelection.current = name;
    setPage(Math.floor(index / pageSize) + 1);
  }, [controller.selectedName, sorted, pageSize]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages);
  const visible = sorted.slice((current - 1) * pageSize, current * pageSize);

  // Reloads keep the current rows on screen; skeletons only cover the very first load.
  const initialLoading = controller.loading && controller.rows.length === 0;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.ec-table__row--selected')?.scrollIntoView({ block: 'nearest' });
  }, [controller.selectedName, current, initialLoading]);
  const stop = (event: MouseEvent) => event.stopPropagation();
  const selectedKey = controller.selectedName
    ? controller.rows.find((row) => row.name === controller.selectedName)?.key
    : undefined;

  const columns: DataTableColumn<CredentialRow>[] = [
    {
      id: 'identity', header: t('authFiles.list.credential'), sortable: true, className: 'ec-cred-col--identity',
      cell: (row) => <CredentialIdentity row={row} showProvider={showProvider} logoSize={density === 'compact' ? 20 : 28} />,
    },
    {
      id: 'plan', header: t('authFiles.list.plan'), className: 'ec-cred-col--plan', width: 96,
      cell: (row) => (row.plan ? <Chip size="sm" tone="neutral">{row.plan}</Chip> : <span className="ec-muted">—</span>),
    },
    {
      id: 'status', header: t('authFiles.list.status'), sortable: true, width: 168,
      cell: (row) => <CredentialStatusCell row={row} />,
    },
    {
      id: 'priority', header: t('authFiles.priority.label'), sortable: true, className: 'ec-cred-col--priority', width: 84,
      cell: (row) => (
        <span title={t('authFiles.priority.button', { priority: row.priority })}>
          <Chip size="sm" tone={row.priority !== 0 ? 'accent' : 'outline'}>{t('sec.providers.creds.priority.short', { priority: row.priority })}</Chip>
        </span>
      ),
    },
    {
      id: 'requests', header: t('authFiles.requests.title'), sortable: true, className: 'ec-cred-col--requests', width: 130,
      cell: (row) => <RequestBar row={row} />,
    },
    {
      id: 'actions', header: <span className="ec-cred-visually-hidden">{t('authFiles.list.actions')}</span>, align: 'end', width: 132,
      cell: (row) => (
        <span className="ec-cred-actions" onClick={stop}>
          {row.quotaProvider ? (
            <a className="ec-cred-link" href={routeHref('quota', null, { cred: row.name })}>
              {t('sec.providers.creds.quotaLink')}<ArrowUpRight size={12} aria-hidden="true" />
            </a>
          ) : null}
          <RowMenu row={row} controller={controller} />
        </span>
      ),
    },
  ];

  if (controller.error && controller.rows.length === 0) {
    return <ErrorState message={mask.text(controller.error)} onRetry={() => void controller.reload()} />;
  }

  const emptyState = controller.rows.length === 0
    ? (
      <EmptyState icon={<FileDown size={20} />} title={t('authFiles.empty.none')}
        action={<Button size="sm" variant="primary" onClick={controller.openImport} disabled={controller.busy}>{t('authFiles.import')}</Button>} />
    )
    : <EmptyState compact title={t('authFiles.empty.filtered')} />;

  return (
    <div className="ec-cred-list" ref={listRef}>
      <DataTable<CredentialRow>
        caption={t('authFiles.title')}
        columns={columns}
        rows={visible}
        rowKey={(row) => row.key}
        loading={initialLoading}
        emptyState={emptyState}
        onRowClick={(row) => controller.select(row.name)}
        selectedKey={selectedKey}
        sort={sort ?? { id: '', dir: 'asc' }}
        onSortChange={setSort}
      />
      {!initialLoading && sorted.length > 0 ? (
        <Pagination page={current} pageSize={pageSize} total={sorted.length} onPage={setPage}
          onPageSize={setPageSize} pageSizes={[10, 20, 50]} />
      ) : null}
    </div>
  );
}
