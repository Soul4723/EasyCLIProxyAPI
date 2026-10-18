import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  cloneCodexModelConfiguration,
  codexContextSourceHint,
  codexReasoningEfforts,
  sameCodexModelConfiguration,
  toggleCodexReasoningLevel,
  validateCodexModelConfiguration,
  type CodexCatalogEditorModel,
  type CodexCatalogEditorSaveResult,
  type CodexCatalogEditorSnapshot,
  type CodexModelConfiguration,
  type CodexReasoningEffort,
} from '../../services/codexModelCatalog';
import { Button, Chip, Dialog, EmptyState, ErrorState, formatCompactNumber, Masked, SearchInput, Skeleton, Toggle } from '../../ui';
import { CatalogDiscardConfirm, CatalogField, CatalogFooter } from './CatalogParts';

/** Codex model catalog editor dialog: batch show/hide, per-model parameters. Props: onClose, onSaved (called after a successful save). */
type CodexCatalogDialogProps = { onClose: () => void; onSaved: () => void | Promise<void> };

const cloneModel = (model: CodexCatalogEditorModel): CodexCatalogEditorModel => ({
  ...model,
  configuration: cloneCodexModelConfiguration(model.configuration),
  defaults: cloneCodexModelConfiguration(model.defaults),
});
const cloneModels = (snapshot: CodexCatalogEditorSnapshot) => snapshot.models.map(cloneModel);
const numberOrNaN = (value: string) => (value ? Number(value) : Number.NaN);
const numberValue = (value: number) => (Number.isFinite(value) ? value : '');

export function CodexCatalogDialog({ onClose, onSaved }: CodexCatalogDialogProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<CodexCatalogEditorSnapshot | null>(null);
  const [models, setModels] = useState<CodexCatalogEditorModel[]>([]);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [checkedSlugs, setCheckedSlugs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultsRestored, setDefaultsRestored] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const load = useCallback(async (restoreDefaults = false) => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const next = await invoke<CodexCatalogEditorSnapshot>('get_codex_model_catalog_editor');
      setSnapshot(next);
      setCheckedSlugs(new Set());
      setModels(cloneModels(next).map((model) => restoreDefaults
        ? { ...model, configuration: cloneCodexModelConfiguration(model.defaults) }
        : model));
      setDefaultsRestored(restoreDefaults);
      setSelectedSlug((current) => next.models.some((model) => model.slug === current)
        ? current
        : next.models[0]?.slug ?? '');
      return true;
    } catch (requestError) {
      setError(String(requestError));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (defaultsRestored) return true;
    if (!snapshot || snapshot.models.length !== models.length) return false;
    return models.some((model) => {
      const saved = snapshot.models.find((candidate) => candidate.slug === model.slug);
      return !saved || !sameCodexModelConfiguration(model.configuration, saved.configuration);
    });
  }, [defaultsRestored, models, snapshot]);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return models;
    return models.filter((model) => model.slug.toLocaleLowerCase().includes(query)
      || model.configuration.display_name.toLocaleLowerCase().includes(query));
  }, [models, search]);

  // Batch selection stays within the current filter, including after name edits.
  const selectedModels = filteredModels.filter((model) => checkedSlugs.has(model.slug));
  const selectedCount = selectedModels.length;
  const allChecked = filteredModels.length > 0 && selectedCount === filteredModels.length;

  useEffect(() => {
    const visibleSlugs = new Set(filteredModels.map((model) => model.slug));
    setCheckedSlugs((current) => [...current].some((slug) => !visibleSlugs.has(slug))
      ? new Set([...current].filter((slug) => visibleSlugs.has(slug)))
      : current);
  }, [filteredModels]);

  const setSelectedVisibility = (visibility: 'list' | 'hide') => {
    const slugs = new Set(selectedModels.map((model) => model.slug));
    setModels((current) => current.map((model) => slugs.has(model.slug)
      ? { ...model, configuration: { ...model.configuration, visibility } }
      : model));
    setError('');
    setNotice('');
  };

  const activeModel = models.find((model) => model.slug === selectedSlug) ?? null;
  const activeCustomized = activeModel
    ? !sameCodexModelConfiguration(activeModel.configuration, activeModel.defaults)
    : false;

  const updateActive = (update: (configuration: CodexModelConfiguration) => CodexModelConfiguration) => {
    setModels((current) => current.map((model) => model.slug === selectedSlug
      ? { ...model, configuration: update(model.configuration) }
      : model));
    setError('');
    setNotice('');
  };

  const updateField = <Key extends keyof CodexModelConfiguration,>(
    field: Key,
    value: CodexModelConfiguration[Key],
  ) => updateActive((current) => ({ ...current, [field]: value }));

  const toggleReasoning = (
    effort: CodexReasoningEffort,
    enabled: boolean,
    defaults: CodexModelConfiguration['supported_reasoning_levels'],
  ) => updateActive((current) => toggleCodexReasoningLevel(current, effort, enabled, defaults));

  const toggleModality = (modality: 'text' | 'image', enabled: boolean) => updateActive((current) => ({
    ...current,
    input_modalities: (['text', 'image'] as const).filter((candidate) => candidate === modality
      ? enabled
      : current.input_modalities.includes(candidate)),
  }));

  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscardConfirmOpen(true);
    else onClose();
  };

  const restoreAll = async () => {
    if (loading || saving) return;
    if (await load(true)) setNotice(t('agents.catalog.restored'));
  };

  const save = async () => {
    if (!snapshot || loading || saving) return;
    for (const model of models) {
      const validationKey = validateCodexModelConfiguration(model.configuration);
      if (validationKey) {
        setSelectedSlug(model.slug);
        setError(t(validationKey));
        setNotice('');
        return;
      }
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await invoke<CodexCatalogEditorSaveResult>('save_codex_model_catalog_editor', {
        request: {
          revision: snapshot.revision,
          models: models.map((model) => ({
            slug: model.slug,
            configuration: model.configuration,
          })),
        },
      });
      setSnapshot(result.snapshot);
      setModels(cloneModels(result.snapshot));
      setDefaultsRestored(false);
      if (result.synchronizationError) {
        setError(t('agents.catalog.syncFailed', { error: result.synchronizationError }));
      } else {
        setNotice(t('agents.catalog.saved'));
      }
      await onSaved();
    } catch (requestError) {
      const message = String(requestError);
      setError(message.includes('CODEX_MODEL_CATALOG_CHANGED')
        ? t('agents.catalog.changed')
        : message);
    } finally {
      setSaving(false);
    }
  };

  const cfg = activeModel?.configuration;
  const batchBusy = loading || saving;

  const list = (
    <div className="cd-list">
      <SearchInput value={search} ariaLabel={t('agents.catalog.search')} placeholder={t('agents.catalog.search')}
        onChange={(value) => { setSearch(value); setCheckedSlugs(new Set()); }} />
      <div className="cd-batch">
        <label className="cd-check" title={t('agents.catalog.selectionHint')}>
          <input type="checkbox" checked={allChecked} disabled={batchBusy || !filteredModels.length}
            ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allChecked; }}
            aria-label={t('agents.catalog.selectFiltered')}
            onChange={(event) => setCheckedSlugs(event.currentTarget.checked
              ? new Set(filteredModels.map((model) => model.slug))
              : new Set())} />
        </label>
        <span className="cd-batch-count ec-num" role="status">
          {t('agents.catalog.selectedCount', { selected: selectedCount, total: filteredModels.length })}
        </span>
        <Button size="xs" variant="ghost" icon={<EyeOff size={12} />} disabled={!selectedCount || batchBusy} onClick={() => setSelectedVisibility('hide')}>{t('agents.catalog.hideSelected')}</Button>
        <Button size="xs" variant="ghost" icon={<Eye size={12} />} disabled={!selectedCount || batchBusy} onClick={() => setSelectedVisibility('list')}>{t('agents.catalog.showSelected')}</Button>
      </div>
      <div className="cd-rows" role="group" aria-label={t('agents.catalog.title')}>
        {loading ? <div aria-busy="true" className="cd-skel"><Skeleton lines={5} height={34} /></div>
          : filteredModels.length ? filteredModels.map((model) => {
            const customized = !sameCodexModelConfiguration(model.configuration, model.defaults);
            const hidden = model.configuration.visibility !== 'list';
            return (
              <div className={`cd-row${model.slug === selectedSlug ? ' is-active' : ''}${hidden ? ' is-hidden' : ''}`} key={model.slug}>
                <label className="cd-check">
                  <input type="checkbox" checked={checkedSlugs.has(model.slug)} disabled={saving}
                    aria-label={t('agents.catalog.selectModel', { model: model.slug })}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setCheckedSlugs((current) => {
                        const next = new Set(current);
                        if (checked) next.add(model.slug);
                        else next.delete(model.slug);
                        return next;
                      });
                    }} />
                </label>
                <button type="button" className="cd-row-main" aria-pressed={model.slug === selectedSlug} onClick={() => setSelectedSlug(model.slug)}>
                  <span className="cd-row-name">{model.configuration.display_name}</span>
                  <span className="cd-row-id ec-mono"><Masked value={model.slug} kind="identifier" mono /></span>
                  <span className="cd-row-chips">
                    <Chip size="sm" tone={model.hasOfficialTemplate ? 'info' : 'outline'}>{model.hasOfficialTemplate ? t('agents.catalog.official') : t('agents.catalog.fallback')}</Chip>
                    {customized ? <Chip size="sm" tone="accent">{t('agents.catalog.customized')}</Chip> : null}
                    {hidden ? <Chip size="sm" tone="warn" icon={<EyeOff size={10} />}>{t('sec.agents.catalog.hidden')}</Chip> : null}
                  </span>
                </button>
                <span className="cd-row-ctx ec-num ec-mono" title={t('sec.agents.catalog.contextShort')}>
                  {Number.isFinite(model.configuration.context_window) ? formatCompactNumber(model.configuration.context_window) : '—'}
                </span>
              </div>
            );
          }) : <EmptyState compact title={t(models.length ? 'agents.catalog.noMatches' : 'agents.catalog.empty')} />}
      </div>
      <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={loading} disabled={loading || saving || dirty} onClick={() => void load()}>
        {t('agents.catalog.reload')}
      </Button>
    </div>
  );

  const editor = (
    <div className="cd-editor">
      {loading ? <div aria-busy="true"><Skeleton lines={8} height={30} /></div>
        : activeModel && cfg ? <>
          <div className="cd-editor-head">
            <h3 className="cd-editor-title ec-mono"><Masked value={activeModel.slug} kind="identifier" mono /></h3>
            <Chip size="sm" tone={activeModel.hasOfficialTemplate ? 'info' : 'outline'}>{activeModel.hasOfficialTemplate ? t('agents.catalog.official') : t('agents.catalog.fallback')}</Chip>
            {activeCustomized ? <Chip size="sm" tone="accent">{t('agents.catalog.customized')}</Chip> : null}
            <span className="cd-editor-spacer" />
            <span className="cd-toggle-inline">
              <Toggle size="sm" label={t('agents.catalog.visible')} checked={cfg.visibility === 'list'} disabled={saving}
                onChange={(next) => updateField('visibility', next ? 'list' : 'hide')} />
              <span>{t('agents.catalog.visible')}</span>
            </span>
          </div>
          <fieldset className="cd-form" disabled={saving}>
            <CatalogField label={t('agents.catalog.displayName')}>
              <input className="cd-input" value={cfg.display_name} onChange={(event) => updateField('display_name', event.currentTarget.value)} />
            </CatalogField>
            <CatalogField label={t('agents.catalog.defaultReasoning')}>
              <select className="cd-input" value={cfg.default_reasoning_level ?? ''}
                onChange={(event) => updateField('default_reasoning_level', (event.currentTarget.value || null) as CodexReasoningEffort | null)}>
                <option value="">{t('agents.catalog.clientDefault')}</option>
                {cfg.supported_reasoning_levels.map((level) => <option key={level.effort} value={level.effort}>{level.effort}</option>)}
              </select>
            </CatalogField>
            <CatalogField wide label={t('agents.catalog.description')}>
              <textarea className="cd-input cd-textarea" rows={2} value={cfg.description ?? ''} onChange={(event) => updateField('description', event.currentTarget.value || null)} />
            </CatalogField>
            <CatalogField label={t('agents.catalog.context')}>
              <input className="cd-input ec-mono" type="number" min="1" value={numberValue(cfg.context_window)} onChange={(event) => updateField('context_window', numberOrNaN(event.currentTarget.value))} />
            </CatalogField>
            <CatalogField label={t('agents.catalog.maximum')}>
              <input className="cd-input ec-mono" type="number" min="1" value={numberValue(cfg.max_context_window)} onChange={(event) => updateField('max_context_window', numberOrNaN(event.currentTarget.value))} />
            </CatalogField>
            <CatalogField label={t('agents.catalog.percent')}>
              <input className="cd-input ec-mono" type="number" min="1" max="100" value={numberValue(cfg.effective_context_window_percent)} onChange={(event) => updateField('effective_context_window_percent', numberOrNaN(event.currentTarget.value))} />
            </CatalogField>
            <CatalogField label={t('agents.catalog.compact')}>
              <input className="cd-input ec-mono" type="number" min="1" placeholder={t('agents.catalog.automatic')} value={cfg.auto_compact_token_limit ?? ''} onChange={(event) => updateField('auto_compact_token_limit', event.currentTarget.value ? Number(event.currentTarget.value) : null)} />
            </CatalogField>
            <div className="cd-field cd-field--wide" role="group" aria-label={t('agents.catalog.reasoning')}>
              <span className="cd-label">{t('agents.catalog.reasoning')}</span>
              <div className="cd-pills">
                {codexReasoningEfforts.map((effort) => {
                  const checked = cfg.supported_reasoning_levels.some((level) => level.effort === effort);
                  return (
                    <label key={effort} className={`cd-pill${checked ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={checked} onChange={(event) => toggleReasoning(effort, event.currentTarget.checked, activeModel.defaults.supported_reasoning_levels)} />
                      <span>{effort}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="cd-field" role="group" aria-label={t('agents.catalog.modalities')}>
              <span className="cd-label">{t('agents.catalog.modalities')}</span>
              <div className="cd-pills">
                {(['text', 'image'] as const).map((modality) => (
                  <label key={modality} className={`cd-pill${cfg.input_modalities.includes(modality) ? ' is-on' : ''}`}>
                    <input type="checkbox" checked={cfg.input_modalities.includes(modality)} onChange={(event) => toggleModality(modality, event.currentTarget.checked)} />
                    <span>{t(`agents.catalog.${modality}`)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="cd-field">
              <span className="cd-label">{t('agents.catalog.parallel')}</span>
              <span className="cd-toggle-inline">
                <Toggle size="sm" label={t('agents.catalog.parallel')} checked={cfg.supports_parallel_tool_calls} onChange={(next) => updateField('supports_parallel_tool_calls', next)} />
              </span>
            </div>
            <CatalogField wide label={t('agents.catalog.systemPrompt')} hint={t('agents.catalog.systemPromptHint')}>
              <textarea className="cd-input cd-textarea cd-prompt ec-mono" rows={10} spellCheck={false} value={cfg.base_instructions} onChange={(event) => updateField('base_instructions', event.currentTarget.value)} />
            </CatalogField>
          </fieldset>
          <p className="cd-source">{t(codexContextSourceHint(activeModel))}</p>
        </>
          : !error ? <EmptyState compact title={t('agents.catalog.empty')} /> : null}
    </div>
  );

  return (
    <>
      <Dialog open size="lg" title={t('agents.catalog.title')} onClose={requestClose} dismissible={!saving}
        footer={<CatalogFooter error={snapshot ? error : ''} notice={notice} dirty={dirty} saveHint={t('agents.catalog.saveHint')}
          busy={loading || saving} saving={saving} canSave={!!snapshot && dirty && !loading && !saving} canReset={!!snapshot}
          onDismissError={() => setError('')} onDismissNotice={() => setNotice('')}
          onResetAll={() => void restoreAll()} onCancel={requestClose} onSave={() => void save()} />}>
        <div className="cd-root">
          {error && !snapshot ? <ErrorState message={<Masked value={error} />} onRetry={() => void load()} /> : (
            <div className="cd-split">{list}{editor}</div>
          )}
        </div>
      </Dialog>
      <CatalogDiscardConfirm open={discardConfirmOpen} onKeep={() => setDiscardConfirmOpen(false)} onDiscard={onClose} />
    </>
  );
}
