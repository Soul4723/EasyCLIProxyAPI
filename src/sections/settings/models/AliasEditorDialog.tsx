import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, BrainCircuit, Check, Search, Zap } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Button, Dialog, Masked, ProviderLogo, SegmentedControl, Toggle } from '../../../ui';
import {
  EFFORT_HINT_KEYS, EFFORT_LABELS, sourceDetail, sourceKindLabel, sourceProviderId,
  type ModelAliasSource,
} from './aliasLogic';

export type AliasEditorState = {
  sourceId: string;
  effort: string;
  fast: boolean;
  alias: string;
};

/**
 * Create / edit dialog for one model alias. State lives in the parent (so it can report dirty and run the commands);
 * this component owns only the model-picker search and highlight state.
 */
export function AliasEditorDialog({
  open, editing, sources, loading, busy, error, state, onChange, onChooseSource, onClose, onSubmit,
}: {
  open: boolean;
  editing: boolean;
  sources: ModelAliasSource[];
  loading: boolean;
  busy: boolean;
  error: string;
  state: AliasEditorState;
  onChange: (patch: Partial<AliasEditorState>) => void;
  onChooseSource: (source: ModelAliasSource) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [active, setActive] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = sources.find((source) => source.id === state.sourceId) ?? null;
  const normalizedEffort = state.effort.trim().toLowerCase();

  useEffect(() => {
    if (!open) { setPickerOpen(false); setSearch(''); }
  }, [open]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const closeOnOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) { setPickerOpen(false); setSearch(''); }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [pickerOpen]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sources;
    return sources
      .map((source, index) => {
        const model = source.model.toLowerCase();
        const displayName = (source.displayName ?? '').toLowerCase();
        const haystack = `${model} ${displayName} ${source.provider} ${sourceKindLabel(source.kind)}`.toLowerCase();
        let score = 5;
        if (model === query) score = 0;
        else if (displayName === query) score = 1;
        else if (model.startsWith(query)) score = 2;
        else if (displayName.startsWith(query)) score = 3;
        else if (haystack.includes(query)) score = 4;
        return { source, index, score };
      })
      .filter((item) => item.score < 5)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((item) => item.source);
  }, [sources, search]);

  useEffect(() => { setActive(0); }, [search, sources]);

  const choose = (source: ModelAliasSource) => {
    onChooseSource(source);
    setPickerOpen(false);
    setSearch('');
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!pickerOpen) { setPickerOpen(true); return; }
      if (!filtered.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + direction + filtered.length) % filtered.length);
    } else if (event.key === 'Enter' && pickerOpen && filtered[active]) {
      event.preventDefault();
      choose(filtered[active]);
    }
  };

  // Escape closes the open picker first, the dialog second (the dialog's own handler calls onClose).
  const requestClose = () => {
    if (pickerOpen) { setPickerOpen(false); setSearch(''); return; }
    onClose();
  };

  const effortOptions = [
    { value: '', label: t('aliases.effort.none'), title: t('aliases.effort.noneHint') },
    ...(selected?.reasoningLevels ?? []).map((level) => {
      const hintKey = EFFORT_HINT_KEYS[level as keyof typeof EFFORT_HINT_KEYS];
      return { value: level, label: EFFORT_LABELS[level] ?? level, title: hintKey ? t(hintKey) : level };
    }),
  ];
  const effortValue = effortOptions.some((option) => option.value === normalizedEffort) ? normalizedEffort : '';
  const modelId = `${ids}-model`;
  const listId = `${ids}-list`;
  const aliasId = `${ids}-alias`;
  const placeholder = selected
    ? normalizedEffort
      ? t('aliases.aliasName.example', { model: selected.model, effort: normalizedEffort })
      : state.fast
        ? t('speedAliases.aliasName.example', { model: selected.model })
        : t('aliases.aliasName.example', { model: selected.model, effort: 'alias' })
    : t('aliases.aliasName.selectFirst');

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      dismissible={!busy}
      size="md"
      title={editing ? t('common.edit') : t('aliases.create.title')}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={loading} onClick={onSubmit}
            icon={state.fast && !normalizedEffort ? <Zap size={14} /> : undefined}>
            {busy ? t(editing ? 'common.saving' : 'aliases.creating') : t(editing ? 'common.save' : 'aliases.create')}
          </Button>
        </>
      )}
    >
      <form className="ec-models-editor" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div className="ec-models-field">
          <label htmlFor={modelId}>{t('aliases.originalModel')}</label>
          <div className="ec-models-picker" ref={pickerRef}>
            <div className="ec-models-picker-input">
              <Search size={14} aria-hidden="true" />
              <input
                id={modelId}
                className="ec-set-input is-wide"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={pickerOpen}
                aria-controls={listId}
                aria-activedescendant={pickerOpen && filtered[active] ? `${ids}-opt-${active}` : undefined}
                value={pickerOpen ? search : selected?.model ?? ''}
                placeholder={loading ? t('aliases.loadingModels') : t('aliases.searchModel')}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={loading || busy}
                onClick={(event) => {
                  if (pickerOpen) return;
                  setSearch(selected?.model ?? '');
                  setPickerOpen(true);
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setSearch(next);
                  setPickerOpen(true);
                  if (selected && next.trim().toLowerCase() !== selected.model.trim().toLowerCase()) {
                    onChange({ sourceId: '', effort: '', fast: false, ...(editing ? {} : { alias: '' }) });
                  }
                }}
                onKeyDown={onSearchKey}
              />
            </div>
            {pickerOpen ? (
              <div className="ec-models-picker-list" id={listId} role="listbox" aria-label={t('aliases.availableModels')}>
                {filtered.length === 0 ? (
                  <div className="ec-models-picker-empty">{sources.length ? t('aliases.noMatch') : t('aliases.noModels')}</div>
                ) : filtered.map((source, index) => (
                  <button
                    key={source.id}
                    id={`${ids}-opt-${index}`}
                    type="button"
                    role="option"
                    aria-selected={source.id === state.sourceId}
                    className={index === active ? 'is-active' : undefined}
                    disabled={busy}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(source)}
                  >
                    <ProviderLogo provider={sourceProviderId(source.kind)} size={20} />
                    <span className="ec-models-picker-copy">
                      <strong title={source.model}>{source.model}</strong>
                      {source.displayName && source.displayName !== source.model ? <small>{source.displayName}</small> : null}
                    </span>
                    <span className="ec-models-picker-kind">{sourceKindLabel(source.kind)}</span>
                    {source.id === state.sourceId ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {selected ? (
            <p className="ec-models-source">
              <ProviderLogo provider={sourceProviderId(selected.kind)} size={16} />
              <span>{sourceKindLabel(selected.kind)}</span>
              <span className="ec-muted ec-trunc"><Masked value={sourceDetail(selected.kind, selected.provider)} /></span>
            </p>
          ) : null}
        </div>

        <div className="ec-models-field">
          <span className="ec-models-field-label">{t('aliases.effort.title')}</span>
          <SegmentedControl
            ariaLabel={t('aliases.effort.title')}
            size="sm"
            value={effortValue}
            onChange={(value) => onChange({ effort: value })}
            options={effortOptions}
          />
          {selected && !selected.supportsReasoning ? <p className="ec-models-hint">{t('aliases.effort.unsupported')}</p> : null}
        </div>

        <div className="ec-models-field ec-models-field-inline">
          <span className="ec-models-field-label"><Zap size={14} aria-hidden="true" /> {t('aliases.fast.title')}</span>
          <Toggle
            label={t('aliases.fast.title')}
            checked={state.fast}
            disabled={busy || !selected?.supportsFast}
            onChange={(fast) => onChange({ fast })}
          />
        </div>
        {selected && !selected.supportsFast ? <p className="ec-models-hint">{t('aliases.fast.unsupported')}</p> : null}

        <div className="ec-models-field">
          <label htmlFor={aliasId}>{t('aliases.aliasName.title')}</label>
          <input
            id={aliasId}
            className="ec-set-input is-wide is-mono"
            value={state.alias}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onChange({ alias: event.currentTarget.value })}
          />
        </div>

        <div className="ec-models-preview" aria-live="polite">
          {state.fast && !normalizedEffort ? <Zap size={16} aria-hidden="true" /> : <BrainCircuit size={16} aria-hidden="true" />}
          <span className="ec-mono">{selected?.model || t('aliases.notSelected')}</span>
          <ArrowRight size={13} aria-hidden="true" />
          <strong className="ec-mono">{state.alias || t('aliases.enterAlias')}</strong>
        </div>

        {error ? <p className="ec-set-row-error" role="alert">{error}</p> : null}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  );
}
