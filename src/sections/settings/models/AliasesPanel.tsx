import { createSettingsRead } from '../../../services/settingsData';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../../services/documentTarget';
import { ArrowRight, Check, GitFork, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usableModelAlias } from '../../../services/modelService';
import {
  Button, Chip, ConfirmDialog, DataTable, EmptyState, ErrorState, IconButton, Masked, ProviderLogo, SearchInput, Skeleton,
  type DataTableColumn,
} from '../../../ui';
import { SettingsGroup } from '../ui';
import { AliasEditorDialog, type AliasEditorState } from './AliasEditorDialog';
import {
  aliasEntryKey, combineModelAliasEntries, combineModelAliasSources, defaultModelAlias, sourceKindLabel,
  sourceProviderId, uniqueModelAlias,
  type AliasListEntry, type ModelAliasEditContext, type ModelAliasSource, type SpeedAliasEntry, type ThinkingAliasEntry,
  type ThinkingAliasSource,
} from './aliasLogic';

const EMPTY_EDITOR: AliasEditorState = { sourceId: '', effort: '', fast: false, alias: '' };

const aliasesRead = createSettingsRead(() => Promise.all([
  invoke<ThinkingAliasEntry[]>('get_thinking_aliases'),
  invoke<ThinkingAliasSource[]>('get_model_alias_sources'),
  invoke<ThinkingAliasSource[]>('get_thinking_alias_sources'),
  invoke<SpeedAliasEntry[]>('get_speed_aliases'),
  invoke<ThinkingAliasSource[]>('get_speed_alias_sources'),
]));

/**
 * Model / thinking / speed aliases. Each add, edit and delete is written to the core config immediately
 * (there is no draft); the only unsaved state is an open editor dialog with changes.
 */
export function AliasesPanel({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [thinkingEntries, setThinkingEntries] = useState<ThinkingAliasEntry[]>([]);
  const [speedEntries, setSpeedEntries] = useState<SpeedAliasEntry[]>([]);
  const [baseSources, setBaseSources] = useState<ThinkingAliasSource[]>([]);
  const [thinkingSources, setThinkingSources] = useState<ThinkingAliasSource[]>([]);
  const [speedSources, setSpeedSources] = useState<ThinkingAliasSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<AliasEditorState>(EMPTY_EDITOR);
  const [initial, setInitial] = useState<AliasEditorState>(EMPTY_EDITOR);
  const [editingEntry, setEditingEntry] = useState<AliasListEntry | null>(null);
  const [editingSource, setEditingSource] = useState<ThinkingAliasSource | null>(null);
  const [busyAlias, setBusyAlias] = useState('');
  const [busyAction, setBusyAction] = useState<'create' | 'edit' | 'delete' | ''>('');
  const [dialogError, setDialogError] = useState('');
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AliasListEntry | null>(null);
  const generatedAliasRef = useRef('');

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setLoadError('');
    try {
      const [nextThinking, nextBase, nextThinkingSources, nextSpeed, nextSpeedSources] = await aliasesRead.read({ fresh });
      setThinkingEntries(nextThinking);
      setSpeedEntries(nextSpeed);
      setBaseSources(nextBase);
      setThinkingSources(nextThinkingSources);
      setSpeedSources(nextSpeedSources);
      setLoaded(true);
    } catch (cause) {
      setLoadError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sources = useMemo<ModelAliasSource[]>(() => {
    const choices = combineModelAliasSources(baseSources, thinkingSources, speedSources);
    if (!editingSource) return choices;
    return [{
      ...editingSource,
      supportsReasoning: editingSource.reasoningLevels.length > 0,
      supportsFast: ['codex-oauth', 'codex-api', 'openai-compatible'].includes(editingSource.kind),
    }, ...choices];
  }, [baseSources, speedSources, thinkingSources, editingSource]);
  const entries = useMemo(() => combineModelAliasEntries(thinkingEntries, speedEntries), [thinkingEntries, speedEntries]);
  const selected = sources.find((source) => source.id === editor.sourceId) ?? null;
  const normalizedEffort = editor.effort.trim().toLowerCase();

  // A source that disappears from the list (or no longer supports Fast) clears the dependent choices.
  useEffect(() => {
    if (editor.sourceId && !selected) setEditor((current) => ({ ...current, sourceId: '' }));
  }, [editor.sourceId, selected]);
  useEffect(() => {
    if (!selected?.supportsFast && editor.fast) setEditor((current) => ({ ...current, fast: false }));
  }, [selected?.supportsFast, editor.fast]);

  // Auto-generated alias name follows the model/effort/fast choice until the user types their own.
  const uniqueDefault = uniqueModelAlias(
    defaultModelAlias(selected?.model, normalizedEffort, editor.fast),
    sources.map((source) => source.model),
  );
  const currentAlias = editor.alias;
  useEffect(() => {
    if (editingEntry) return;
    const value = currentAlias.trim();
    if (value && value !== generatedAliasRef.current) return;
    generatedAliasRef.current = uniqueDefault;
    if (currentAlias !== uniqueDefault) setEditor((current) => ({ ...current, alias: uniqueDefault }));
  }, [uniqueDefault, editingEntry, currentAlias]);

  const dirty = editorOpen && JSON.stringify(editor) !== JSON.stringify(initial);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const resetEditor = () => {
    setEditingEntry(null);
    setEditingSource(null);
    setEditor(EMPTY_EDITOR);
    setInitial(EMPTY_EDITOR);
    setDialogError('');
    generatedAliasRef.current = '';
  };

  const openCreate = () => {
    resetEditor();
    setPageError('');
    setNotice('');
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (busyAction === 'create') return;
    setEditorOpen(false);
    resetEditor();
  };

  const chooseSource = (source: ModelAliasSource) => {
    setEditor((current) => ({ ...current, sourceId: source.id, effort: '', fast: current.fast && source.supportsFast, ...(editingEntry ? {} : { alias: '' }) }));
    generatedAliasRef.current = '';
  };

  const openEdit = async (entry: AliasListEntry) => {
    setBusyAlias(entry.alias);
    setBusyAction('edit');
    setPageError('');
    setNotice('');
    try {
      // Fresh editor context is a one-shot action, not shared list state.
      const context = await invoke<ModelAliasEditContext>('get_model_alias_edit_source', { alias: entry.alias, entry });
      const next = { sourceId: context.source.id, effort: context.effort ?? '', fast: context.fast, alias: entry.alias };
      generatedAliasRef.current = '';
      setDialogError('');
      setEditingEntry(entry);
      setEditingSource(context.source);
      setEditor(next);
      setInitial(next);
      setEditorOpen(true);
    } catch (cause) {
      setPageError(String(cause));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  const submit = async () => {
    if (!selected) { setDialogError(t('aliases.error.selectModel')); return; }
    const alias = editor.alias.trim();
    if (!alias) { setDialogError(t('aliases.error.emptyAlias')); return; }
    const keepingExisting = Boolean(editingEntry && editingEntry.alias.trim().toLowerCase() === alias.toLowerCase());
    if (!keepingExisting && !usableModelAlias(alias)) { setDialogError(t('aliases.error.invalidAlias')); return; }
    if (editor.fast && !selected.supportsFast) { setDialogError(t('aliases.error.unsupportedFast')); return; }
    if (normalizedEffort && !selected.supportsReasoning) { setDialogError(t('aliases.error.unsupportedEffort')); return; }
    setBusyAlias(alias);
    setBusyAction('create');
    setDialogError('');
    setPageError('');
    setNotice('');
    try {
      if (editingEntry) {
        await invoke('create_thinking_alias', {
          sourceId: selected.id, alias, effort: normalizedEffort, fast: editor.fast,
          originalAlias: editingEntry.alias, originalEntry: editingEntry,
        });
        setNotice(t('aliases.updated', { alias }));
      } else if (normalizedEffort) {
        await invoke<ThinkingAliasEntry[]>('create_thinking_alias', {
          sourceId: selected.id, alias, effort: normalizedEffort, fast: editor.fast,
        });
        setNotice(t(editor.fast ? 'aliases.createdCombined' : 'aliases.created', { alias, effort: normalizedEffort }));
      } else if (editor.fast) {
        await invoke<SpeedAliasEntry[]>('create_speed_alias', { sourceId: selected.id, alias });
        setNotice(t('speedAliases.created', { alias }));
      } else {
        await invoke<ThinkingAliasEntry[]>('create_thinking_alias', {
          sourceId: selected.id, alias, effort: '', fast: false,
        });
        setNotice(t('aliases.createdPlain', { alias }));
      }
      await load(true);
      setEditorOpen(false);
      resetEditor();
    } catch (cause) {
      setDialogError(String(cause));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  const remove = async (entry: AliasListEntry) => {
    setBusyAlias(entry.alias);
    setBusyAction('delete');
    setPageError('');
    setNotice('');
    try {
      if (entry.effort || !entry.serviceTier) {
        await invoke<ThinkingAliasEntry[]>('delete_thinking_alias', { alias: entry.alias, oauthChannel: entry.oauthChannel, entry });
      } else {
        await invoke<SpeedAliasEntry[]>('delete_speed_alias', { alias: entry.alias, oauthChannel: entry.oauthChannel, entry });
      }
      setNotice(t('aliases.deleted', { alias: entry.alias }));
      await load(true);
    } catch (cause) {
      setPageError(String(cause));
    } finally {
      setBusyAlias('');
      setBusyAction('');
      setConfirmDelete(null);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.alias} ${entry.sourceModel} ${entry.provider} ${sourceKindLabel(entry.kind)}`.toLowerCase().includes(needle));
  }, [entries, query]);

  const busy = Boolean(busyAlias);
  const columns: DataTableColumn<AliasListEntry>[] = [
    {
      id: 'source', header: t('sec.settings.models.col.source'), sortable: true, sortValue: (entry) => entry.sourceModel.toLowerCase(),
      cell: (entry) => (
        <div className="ec-models-source-cell">
          <ProviderLogo provider={sourceProviderId(entry.kind)} size={22} />
          <div className="ec-models-source-copy">
            <span className="ec-mono ec-trunc" title={entry.sourceModel}>{entry.sourceModel}</span>
            <small className="ec-muted ec-trunc">
              {sourceKindLabel(entry.kind)}
              {entry.provider !== sourceKindLabel(entry.kind) ? <> · <Masked value={entry.provider} /></> : null}
            </small>
          </div>
        </div>
      ),
    },
    { id: 'arrow', header: <span className="ec-models-sr">→</span>, width: 28, align: 'center', cell: () => <ArrowRight size={14} className="ec-models-arrow" aria-hidden="true" /> },
    {
      id: 'alias', header: t('sec.settings.models.col.alias'), sortable: true, sortValue: (entry) => entry.alias.toLowerCase(),
      cell: (entry) => <strong className="ec-mono ec-trunc ec-models-alias" title={entry.alias}>{entry.alias}</strong>,
    },
    {
      id: 'options', header: t('sec.settings.models.col.options'),
      cell: (entry) => (
        <span className="ec-models-badges">
          {entry.effort ? <Chip size="sm" tone="info">{entry.effort}</Chip> : null}
          {entry.serviceTier ? <Chip size="sm" tone="warn" icon={<Zap size={11} />}>{t('speedAliases.fast.title')}</Chip> : null}
          {!entry.effort && !entry.serviceTier ? <span className="ec-muted">—</span> : null}
        </span>
      ),
    },
    {
      id: 'actions', header: <span className="ec-models-sr">{t('sec.settings.models.col.actions')}</span>, width: 80, align: 'end',
      cell: (entry) => (
        <span className="ec-models-actions">
          <IconButton size="sm" label={t('common.edit')} icon={<Pencil size={14} />} disabled={busy} onClick={() => void openEdit(entry)} />
          <IconButton size="sm" label={t('aliases.delete', { alias: entry.alias })} icon={<Trash2 size={14} />} disabled={busy} onClick={() => setConfirmDelete(entry)} />
        </span>
      ),
    },
  ];

  const instantChip = (
    <span title={t('sec.settings.models.instantHint')}>
      <Chip size="sm" tone="ok">{t('sec.settings.effect.instant')}</Chip>
    </span>
  );

  return (
    <div className="ec-models-panel">
      {loadError && !loaded ? (
        <ErrorState title={t('sec.settings.loadFailed')} message={loadError} onRetry={() => void load(true)} />
      ) : (
        <SettingsGroup
          title={t('app.nav.thinkingAliases')}
          icon={<GitFork size={16} />}
          status={<>{instantChip}<Chip size="sm" tone="neutral">{entries.length}</Chip></>}
          actions={(
            <Button size="sm" variant="primary" icon={<Plus size={14} />} disabled={loading || busy} onClick={openCreate}>
              {t('aliases.create')}
            </Button>
          )}
        >
          {pageError ? (
            <div className="ec-models-banner is-error" role="alert">
              <span>{pageError}</span>
              <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={() => setPageError('')} />
            </div>
          ) : null}
          {notice && !pageError ? (
            <div className="ec-models-banner is-ok" role="status">
              <Check size={14} aria-hidden="true" /><span>{notice}</span>
              <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={() => setNotice('')} />
            </div>
          ) : null}
          {loading && !loaded ? (
            <div className="ec-set-skel" aria-busy="true"><Skeleton lines={4} /></div>
          ) : entries.length === 0 ? (
            <EmptyState
              compact
              icon={<GitFork size={22} />}
              title={t('aliases.empty.title')}
              action={<Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={openCreate}>{t('aliases.create')}</Button>}
            />
          ) : (
            <>
              {entries.length > 6 ? (
                <div className="ec-models-search">
                  <SearchInput value={query} onChange={setQuery} placeholder={t('sec.settings.models.search')} />
                </div>
              ) : null}
              <DataTable
                className="ec-models-table"
                caption={t('app.nav.thinkingAliases')}
                columns={columns}
                rows={visible}
                rowKey={aliasEntryKey}
                loading={loading && !loaded}
                emptyState={<EmptyState compact title={t('aliases.noMatch')} />}
              />
            </>
          )}
        </SettingsGroup>
      )}

      <AliasEditorDialog
        open={editorOpen}
        editing={Boolean(editingEntry)}
        sources={sources}
        loading={loading && !loaded}
        busy={busyAction === 'create'}
        error={dialogError}
        state={editor}
        onChange={(patch) => setEditor((current) => ({ ...current, ...patch }))}
        onChooseSource={chooseSource}
        onClose={closeEditor}
        onSubmit={() => void submit()}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('common.delete')}
        message={<span className="ec-models-confirm">{t('aliases.deleteConfirm', { alias: confirmDelete?.alias ?? '' })}</span>}
        confirmLabel={t('common.delete')}
        danger
        busy={busyAction === 'delete'}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }}
      />
    </div>
  );
}
