import { Archive, Database, FileText, RefreshCw, ScanSearch, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { codexSessionPageCounts, type CodexSessionSummary } from '../../../services/codexSessionState';
import {
  Badge, Button, Chip, ConfirmDialog, DataTable, EmptyState, ErrorState, FilterChips, IconButton, Masked, Pagination, ProgressBar,
  RelativeTime, SearchInput, type DataTableColumn,
} from '../../../ui';
import { CleanupDialog } from './CleanupDialog';
import { SessionEditor } from './SessionEditor';
import { SessionNotice } from './SessionNotice';
import { useSessionsList } from './useSessionsList';
import './sessions.css';

type StatusFilter = 'all' | 'active' | 'archived';

/** Keeps clicks on in-row controls (checkbox, action buttons) from also opening the row's editor. */
const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * Codex sessions sub-page: paged DataTable of local sessions with selection + batch delete, metadata repair, session-index
 * cleanup (preview dialog) and a row-opened context editor panel. All command calls live in the two hooks.
 */
export function SessionsView() {
  const { t, formatNumber } = useI18n();
  const mask = usePrivacyMask();
  const list = useSessionsList();
  const { page, loading, busy, operation, selectedIds } = list;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<CodexSessionSummary | null>(null);

  const sessions = page?.sessions ?? [];
  const counts = codexSessionPageCounts(sessions);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (status === 'active' && session.archived) return false;
      if (status === 'archived' && !session.archived) return false;
      if (!needle) return true;
      return [session.title, session.cwd, session.id, session.modelProvider].some((value) => value.toLowerCase().includes(needle));
    });
  }, [sessions, query, status]);

  const selectedSessions = sessions.filter((session) => selectedIds.has(session.id));
  const visibleSelected = visible.filter((session) => selectedIds.has(session.id)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const toggleAllVisible = (checked: boolean) => {
    list.setSelectedIds((current) => {
      const next = new Set(current);
      for (const session of visible) {
        if (checked) next.add(session.id);
        else next.delete(session.id);
      }
      return next;
    });
  };

  const deleteTargets = deleteIds ? sessions.filter((session) => deleteIds.includes(session.id)) : [];
  const deletePreview = deleteTargets.slice(0, 6).map((session) => mask.text(session.title || session.id)).join('、');
  const deleteExtra = Math.max(0, deleteTargets.length - 6);
  const confirmDelete = async () => {
    if (!deleteIds) return;
    await list.deleteSessions(deleteIds);
    setDeleteIds(null);
  };

  const untitled = t('agents.sessions.untitled');
  const columns: DataTableColumn<CodexSessionSummary>[] = [
    {
      id: 'select',
      width: 40,
      header: (
        <input type="checkbox" className="ses-check" aria-label={t('sec.agents.sessions.selectAllLabel')}
          checked={allVisibleSelected} disabled={busy || visible.length === 0}
          ref={(node) => { if (node) node.indeterminate = visibleSelected > 0 && !allVisibleSelected; }}
          onChange={(event) => toggleAllVisible(event.currentTarget.checked)} />
      ),
      cell: (session) => (
        <span onClick={stop}>
          <input type="checkbox" className="ses-check" checked={selectedIds.has(session.id)} disabled={busy}
            aria-label={t('agents.sessions.selectSession', { title: mask.text(session.title || session.id) })}
            onChange={(event) => list.setSelected(session.id, event.currentTarget.checked)} />
        </span>
      ),
    },
    {
      id: 'title',
      header: t('sec.agents.sessions.col.title'),
      sortable: true,
      sortValue: (session) => session.title.toLowerCase(),
      cell: (session) => (
        <span className="ses-title">
          <span className="ses-title-line">
            <Masked className="ses-title-text ec-trunc" value={session.title || untitled} />
            {session.archived ? <span className="ses-title-chip"><Chip size="sm">{t('agents.sessions.archivedBadge')}</Chip></span> : null}
          </span>
          <Masked kind="identifier" mono className="ses-id ec-trunc ec-muted" value={session.id} />
        </span>
      ),
    },
    {
      id: 'workspace',
      width: '28%',
      header: t('sec.agents.sessions.col.workspace'),
      className: 'ses-col-workspace',
      cell: (session) => session.cwd
        ? <Masked kind="identifier" mono className="ses-cwd ec-trunc" value={session.cwd} />
        : <span className="ec-muted">{t('agents.sessions.noProject')}</span>,
    },
    {
      id: 'provider',
      width: 140,
      header: t('sec.agents.sessions.col.provider'),
      className: 'ses-col-provider',
      sortable: true,
      sortValue: (session) => session.modelProvider.toLowerCase(),
      cell: (session) => session.modelProvider
        ? <Chip size="sm" tone="outline">{session.modelProvider}</Chip>
        : <span className="ec-muted">{t('agents.sessions.noProvider')}</span>,
    },
    {
      id: 'updated',
      header: t('sec.agents.sessions.col.updated'),
      width: 110,
      sortable: true,
      sortValue: (session) => session.updatedAtMs,
      cell: (session) => (
        <span className="ec-muted ec-num"><RelativeTime value={session.updatedAtMs} fallback={t('agents.sessions.noTime')} /></span>
      ),
    },
    {
      id: 'status',
      header: t('sec.agents.sessions.col.status'),
      width: 116,
      className: 'ses-col-status',
      cell: (session) => session.archived
        ? <Chip size="sm" icon={<Archive size={11} />}>{t('agents.sessions.archivedBadge')}</Chip>
        : null,
    },
    {
      id: 'actions',
      width: 84,
      align: 'end',
      header: <span className="ses-sr">{t('common.edit')}</span>,
      cell: (session) => (
        <span className="ses-row-actions" onClick={stop}>
          <IconButton size="sm" label={t('agents.sessions.editContext')} icon={<FileText size={14} />} disabled={busy}
            onClick={() => setEditing(session)} />
          <IconButton size="sm" label={t('common.delete')} icon={<Trash2 size={14} />} disabled={busy}
            onClick={() => setDeleteIds([session.id])} />
        </span>
      ),
    },
  ];

  const total = page?.totalCount ?? sessions.length;
  const currentPage = Math.floor(list.currentOffset / list.pageLimit) + 1;
  const showError = Boolean(list.loadError) && !page && !loading;
  const empty = !loading && page !== null && total === 0;
  const filtering = query.trim() !== '' || status !== 'all';
  const progress = list.repairProgress;
  const phaseText = t(`agents.sessions.progress.${progress.phase}` as
    | 'agents.sessions.progress.scanning' | 'agents.sessions.progress.backingUp' | 'agents.sessions.progress.rewriting'
    | 'agents.sessions.progress.updatingDatabase' | 'agents.sessions.progress.complete');

  return (
    <div className="ses-page">
      <div className="ses-toolbar">
        <div className="ses-search" title={t('sec.agents.sessions.pageNote')}>
          <SearchInput value={query} onChange={setQuery} placeholder={t('sec.agents.sessions.search')} />
        </div>
        <FilterChips ariaLabel={t('sec.agents.sessions.col.status')} value={status} onChange={setStatus} options={[
          { value: 'all', label: t('sec.agents.filter.all'), count: sessions.length },
          { value: 'active', label: t('agents.sessions.active'), count: counts.active },
          { value: 'archived', label: t('agents.sessions.archived'), count: counts.archived },
        ]} />
        <span className="ses-spacer" />
        <IconButton label={t('agents.sessions.refresh')} icon={<RefreshCw size={14} className={loading ? 'ses-spin' : ''} />}
          disabled={busy || loading} onClick={() => void list.loadPage(list.currentOffset)} />
        <Button variant="secondary" icon={<ScanSearch size={14} />} loading={operation === 'preview'} disabled={busy || loading}
          title={t('agents.sessions.scanIndex')} onClick={() => void list.previewCleanup()}>
          {operation === 'preview' ? t('sec.agents.sessions.cleanupChecking') : t('sec.agents.sessions.cleanup')}
        </Button>
        <Button variant="secondary" icon={<ShieldCheck size={14} />} loading={operation === 'repair'} disabled={busy}
          title={t('sec.agents.sessions.repairHint')} onClick={() => void list.repairSessions()}>
          {operation === 'repair' ? t('sec.agents.sessions.repairing') : t('sec.agents.sessions.repair')}
        </Button>
      </div>

      {operation === 'repair' ? (
        <div className="ses-progress" role="status">
          <span>{phaseText}{progress.total > 0 ? ` · ${t('agents.sessions.progressCount', { processed: progress.processed, total: progress.total })}` : ''}</span>
          <ProgressBar value={progress.percent} label={phaseText} />
          <span className="ec-num ec-muted">{progress.percent}%</span>
        </div>
      ) : null}

      {list.notice && !showError ? (
        <SessionNotice kind={list.notice.kind} message={list.notice.message} onDismiss={() => list.setNotice(null)} />
      ) : null}

      {page && page.warnings.length > 0 ? (
        <div className="ses-warnings" role="status">
          <span className="ses-warnings-head"><TriangleAlert size={14} aria-hidden />{t('sec.agents.sessions.warnings')}<Badge tone="warn" count={page.warnings.length} /></span>
          <ul>{page.warnings.map((warning, index) => <li key={index}><Masked value={warning} /></li>)}</ul>
        </div>
      ) : null}

      {selectedSessions.length > 0 ? (
        <div className="ses-selbar" role="region" aria-label={t('agents.sessions.selected', { count: selectedSessions.length })}>
          <Chip tone="accent">{t('agents.sessions.selected', { count: selectedSessions.length })}</Chip>
          <Button size="sm" variant="ghost" icon={<X size={13} />} disabled={busy} onClick={() => list.setSelectedIds(new Set())}>
            {t('agents.sessions.clearSelection')}
          </Button>
          <span className="ses-spacer" />
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={busy}
            onClick={() => setDeleteIds(selectedSessions.map((session) => session.id))}>
            {t('common.delete')}
          </Button>
        </div>
      ) : null}

      {showError ? (
        <ErrorState title={t('sec.agents.sessions.errorTitle')} message={list.loadError ? <Masked value={list.loadError} /> : undefined}
          onRetry={() => void list.loadPage(list.currentOffset)} />
      ) : empty ? (
        <EmptyState icon={<Archive size={20} />} title={t('agents.sessions.empty')}
          action={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void list.loadPage(0)}>{t('sec.agents.sessions.emptyAction')}</Button>} />
      ) : (
        <DataTable
          className="ses-table"
          caption={t('sec.agents.sessions.caption')}
          columns={columns}
          rows={visible}
          rowKey={(session) => session.id}
          loading={loading}
          onRowClick={(session) => { if (!busy) setEditing(session); }}
          emptyState={<EmptyState compact title={filtering ? t('sec.agents.sessions.noMatches') : t('agents.sessions.empty')} />}
        />
      )}

      {page && total > 0 ? (
        <div className="ses-foot-row">
          <span className="ses-meta">
            <Chip size="sm">{t('sec.agents.sessions.count', { count: formatNumber(total) })}</Chip>
            <span title={page.databasePaths.join('\n') || page.codexHome}>
              <Chip size="sm" tone={page.databasePaths[0] ? 'outline' : 'warn'} icon={<Database size={11} />}>
                {page.databasePaths[0]
                  ? <Masked kind="identifier" mono className="ses-db ec-trunc" value={page.databasePaths[0]} />
                  : t('agents.sessions.databaseMissing')}
              </Chip>
            </span>
          </span>
          <div className={busy || loading ? 'ses-pager ses-pager--busy' : 'ses-pager'}>
            <Pagination page={currentPage} pageSize={list.pageLimit} total={total}
              onPage={(next) => void list.loadPage((next - 1) * list.pageLimit)} />
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteIds !== null}
        danger
        busy={operation === 'delete'}
        title={deleteTargets.length === 1
          ? t('agents.sessions.deleteOneTitle')
          : t('agents.sessions.deleteManyTitle', { count: deleteTargets.length })}
        message={deleteTargets.length === 1
          ? t('agents.sessions.deleteOneDescription', { title: deletePreview })
          : t('agents.sessions.deleteManyDescription', {
            count: deleteTargets.length,
            preview: deletePreview,
            extra: deleteExtra > 0 ? t('agents.sessions.deleteMore', { count: deleteExtra }) : '',
          })}
        confirmLabel={t('agents.sessions.confirmDelete')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteIds(null)}
      />

      {list.cleanupPreview ? (
        <CleanupDialog
          preview={list.cleanupPreview}
          selectedIds={list.cleanupSelectedIds}
          onSelectedIds={list.setCleanupSelectedIds}
          applying={operation === 'cleanup'}
          onApply={() => void list.applyCleanup()}
          onClose={list.closeCleanup}
        />
      ) : null}

      {editing ? (
        <SessionEditor
          sessionId={editing.id}
          fallbackTitle={editing.title}
          onClose={() => setEditing(null)}
          onSessionUpdated={() => void list.loadPage(list.currentOffset, true)}
        />
      ) : null}
    </div>
  );
}
