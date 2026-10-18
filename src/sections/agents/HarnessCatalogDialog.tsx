import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, RotateCcw, Settings2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import {
  harnessContextDefault, harnessDraft, harnessReasoningLevels, harnessSchema, isHarnessRecord, parseHarnessDraft, sameHarnessDraft, updateHarnessDraft,
  type HarnessContextDefault, type HarnessDraft, type HarnessEditorSnapshot, type HarnessProfile,
} from '../../services/deepSeekHarnessCatalog';
import { Button, Chip, Dialog, EmptyState, ErrorState, Masked, SearchInput, Skeleton } from '../../ui';
import { CatalogDiscardConfirm, CatalogField, CatalogFooter } from './CatalogParts';

/** DeepSeek Harness catalog editor dialog: provider settings + per-model overrides. Props: onClose, onSaved (called after a successful save). */
type HarnessCatalogDialogProps = { onClose: () => void; onSaved: () => void | Promise<void> };

const CustomizedBadge = () => {
  const { t } = useI18n();
  return <Chip size="sm" tone="accent">{t('agents.catalog.customized')}</Chip>;
};

function HarnessContextWindowInput({ label, value, inherited, onChange }: {
  label: string; value?: string; inherited: HarnessContextDefault; onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <CatalogField label={label} badge={value !== undefined ? <CustomizedBadge /> : null}
      hint={<span className="cd-source-line">
        {t(`agents.harness.contextSource.${value !== undefined ? 'custom' : inherited.source}`)}
        {value !== undefined ? <Button size="xs" variant="ghost" onClick={() => { setEditing(null); onChange(''); }}>{t('agents.harness.resetContext')}</Button> : null}
      </span>}>
      <input className="cd-input ec-mono" aria-label={label} type="number" min={1} step={1} value={editing ?? value ?? String(inherited.value)}
        onFocus={event => setEditing(event.currentTarget.value)}
        onChange={event => { setEditing(event.currentTarget.value); onChange(event.currentTarget.value); }}
        onBlur={() => setEditing(null)} />
    </CatalogField>
  );
}

function HarnessReasoningField({ name, label, value, automatic, onChange }: {
  name: string; label: string; value: string; automatic: string; onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  let mapping: HarnessProfile = {};
  try { const parsed: unknown = JSON.parse(value || '{}'); if (isHarnessRecord(parsed)) mapping = parsed; } catch { /* custom JSON mid-edit */ }
  const has = (level: string) => Object.prototype.hasOwnProperty.call(mapping, level);
  return (
    <div className="cd-field cd-field--wide" key={name}>
      <label className="cd-field">
        <span className="cd-label">{label}</span>
        <select className="cd-input" aria-label={label} value={!value ? '' : value === 'false' ? 'false' : 'custom'}
          onChange={e => onChange(e.currentTarget.value === 'custom' ? JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high' }) : e.currentTarget.value)}>
          <option value="">{automatic}</option>
          <option value="false">{t('agents.harness.reasoningDisabled')}</option>
          <option value="custom">{t('agents.harness.reasoningCustom')}</option>
        </select>
      </label>
      {value && value !== 'false' ? (
        <div className="cd-levels">
          {harnessReasoningLevels.map(level => (
            <div className="cd-level" key={level}>
              <label className={`cd-pill${has(level) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={has(level)} onChange={e => {
                  const next = { ...mapping }; if (e.currentTarget.checked) next[level] = level === 'off' ? null : level; else delete next[level]; onChange(JSON.stringify(next));
                }} />
                <span>{level}</span>
              </label>
              {has(level) ? <input className="cd-input ec-mono" aria-label={`${level} reasoning_effort`} title={t('sec.agents.catalog.reasoningWire', { level })} value={String(mapping[level] ?? '')}
                placeholder={level === 'off' ? t('agents.harness.noWireValue') : level}
                onChange={e => onChange(JSON.stringify({ ...mapping, [level]: level === 'off' && !e.currentTarget.value ? null : e.currentTarget.value }))} /> : null}
            </div>
          ))}
        </div>
      ) : null}
      <small className="cd-hint">{t('agents.harness.hint.reasoningEfforts')}</small>
    </div>
  );
}

function HarnessFields({ group, draft, defaults = {}, prefix = '', api, contextDefault, onChange }: {
  group: string; draft: HarnessDraft; defaults?: HarnessProfile; prefix?: string; api: string;
  contextDefault?: HarnessContextDefault;
  onChange: (next: HarnessDraft) => void;
}) {
  const { t } = useI18n();
  const label = (name: string) => t(`agents.harness.field.${name}` as MessageKey);
  return <div className="cd-form">{harnessSchema[group].map(field => {
    const key = `${prefix}${field.name}`;
    const value = draft[key] ?? '';
    const supplied = defaults[field.name] ?? field.default;
    const automatic = `${t('agents.harness.auto')}${supplied === undefined ? '' : ` (${typeof supplied === 'string' ? supplied : JSON.stringify(supplied)})`}`;
    const set = (next: string) => onChange(updateHarnessDraft(draft, key, next));
    const overridden = Object.prototype.hasOwnProperty.call(draft, key);
    if (field.name === 'contextWindow' || field.name === 'defaultContextWindow') {
      return <HarnessContextWindowInput key={key} label={label(field.name)} value={draft[key]} inherited={contextDefault ?? harnessContextDefault({}, {})} onChange={set} />;
    }
    if (field.apis && !field.apis.includes(api) && !value) return null;
    if (field.group) {
      const customized = Object.keys(draft).some(k => k.startsWith(`${key}.`));
      return (
        <details className="cd-group cd-field--wide" key={key}>
          <summary>{label(field.name)}{customized ? <CustomizedBadge /> : null}</summary>
          <p className="cd-hint">{t(`agents.harness.hint.${field.name}` as MessageKey)}</p>
          <HarnessFields group={field.group} draft={draft} defaults={isHarnessRecord(supplied) ? supplied : {}} prefix={`${key}.`} api={api} onChange={onChange} />
          {customized ? <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => onChange(Object.fromEntries(Object.entries(draft).filter(([k]) => !k.startsWith(`${key}.`))))}>{t('agents.harness.resetGroup')}</Button> : null}
        </details>
      );
    }
    if (field.kind === 'reasoning') {
      return <HarnessReasoningField key={key} name={key} label={label(field.name)} value={value} automatic={automatic} onChange={set} />;
    }
    const jsonField = ['headers', 'kwargs', 'strings'].includes(field.kind);
    const hinted = ['input', 'defaultInput', 'maxTokens', 'defaultMaxTokens', 'api', 'headers'].includes(field.name);
    return (
      <CatalogField key={key} wide={jsonField} label={<span title={field.name}>{label(field.name)}</span>} badge={overridden ? <CustomizedBadge /> : null}
        hint={hinted ? t(`agents.harness.hint.${field.name}` as MessageKey) : undefined}>
        {['enum', 'boolean', 'modalities'].includes(field.kind) ? (
          <select className="cd-input" aria-label={label(field.name)} value={value} onChange={e => set(e.currentTarget.value)}>
            <option value="">{automatic}</option>
            {field.kind === 'boolean' ? <><option value="true">{t('agents.harness.yes')}</option><option value="false">{t('agents.harness.no')}</option></> : null}
            {field.kind === 'enum' ? field.values!.map(v => <option key={v} value={v}>{v}</option>) : null}
            {field.kind === 'modalities' ? <>
              {field.name === 'input' ? <option value="[]">{t('agents.harness.providerInput')}</option> : null}
              <option value='["text"]'>{t('agents.harness.textOnly')}</option>
              <option value='["text","image"]'>{t('agents.harness.textImage')}</option>
              <option value='["image"]'>{t('agents.catalog.image')}</option>
            </> : null}
          </select>
        ) : jsonField ? (
          <textarea className="cd-input cd-textarea ec-mono" aria-label={label(field.name)} rows={4} spellCheck={false} value={value}
            placeholder={JSON.stringify(supplied ?? field.example, null, 2) ?? automatic} onChange={e => set(e.currentTarget.value)} />
        ) : (
          <input className={`cd-input${['integer', 'number'].includes(field.kind) ? ' ec-mono' : ''}`} aria-label={label(field.name)} type={['integer', 'number'].includes(field.kind) ? 'number' : 'text'}
            min={field.min ?? field.exclusiveMin} max={field.max} step={field.kind === 'integer' ? 1 : 'any'} value={value} placeholder={automatic} onChange={e => set(e.currentTarget.value)} />
        )}
      </CatalogField>
    );
  })}</div>;
}

export function HarnessCatalogDialog({ onClose, onSaved }: HarnessCatalogDialogProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<HarnessEditorSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, HarnessDraft>>({});
  const [provider, setProvider] = useState<HarnessDraft>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<'close' | 'reload' | null>(null);
  const install = (next: HarnessEditorSnapshot) => {
    setSnapshot(next);
    setDrafts(Object.fromEntries(next.models.map(m => [m.id, harnessDraft(m.configuration, 'model')])));
    setProvider(harnessDraft(next.provider, 'provider'));
  };
  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotice('');
    try {
      const next = await invoke<HarnessEditorSnapshot>('get_deepseek_harness_model_catalog_editor');
      install(next);
      setSelected(current => current && next.models.some(m => m.id === current) ? current : next.defaultModel ?? next.models[0]?.id ?? null);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const dirty = !!snapshot && (!sameHarnessDraft(provider, harnessDraft(snapshot.provider, 'provider'))
    || snapshot.models.some(m => !sameHarnessDraft(drafts[m.id] ?? {}, harnessDraft(m.configuration, 'model'))));
  const close = () => { if (!saving) { if (dirty) setConfirmation('close'); else onClose(); } };
  const active = snapshot?.models.find(m => m.id === selected);
  const api = provider.api || 'openai-completions';
  const changed = () => { setNotice(''); setError(''); };
  const save = async () => {
    if (!snapshot || saving || loading) return;
    let request;
    try {
      let configuration;
      try { configuration = parseHarnessDraft(provider, 'provider', api); }
      catch (e) { setSelected(null); throw e; }
      request = { revision: snapshot.revision, provider: configuration, models: snapshot.models.map(m => {
        try { return { ...m, configuration: parseHarnessDraft(drafts[m.id] ?? {}, 'model', api) }; }
        catch (e) { setSelected(m.id); throw e; }
      }) };
    } catch (e) { setError(t('agents.harness.invalid', { field: String(e).replace(/^Error: /, '') })); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await invoke<HarnessEditorSnapshot>('save_deepseek_harness_model_catalog_editor', { request });
      install(next); setNotice(t(next.configured ? 'agents.harness.saved' : 'agents.harness.savedDraft'));
      await onSaved();
    } catch (e) { setError(String(e).includes('DSH_MODEL_CATALOG_CHANGED') ? t('agents.harness.changed') : String(e)); }
    finally { setSaving(false); }
  };

  const modelName = (m: HarnessEditorSnapshot['models'][number]) => drafts[m.id]?.name || String(m.defaults.name ?? m.id);
  const query = search.toLowerCase();
  const visible = snapshot?.models.filter(m => `${m.id} ${drafts[m.id]?.name ?? m.defaults.name ?? ''}`.toLowerCase().includes(query)) ?? [];

  const list = (
    <div className="cd-list">
      <button type="button" className={`cd-provider-btn${selected === null ? ' is-active' : ''}`} aria-pressed={selected === null} onClick={() => setSelected(null)}>
        <Settings2 size={14} aria-hidden />{t('agents.harness.provider')}
      </button>
      <SearchInput value={search} ariaLabel={t('agents.catalog.search')} placeholder={t('agents.catalog.search')} onChange={setSearch} />
      <div className="cd-rows" role="listbox" aria-label={t('agents.harness.title')}>
        {loading ? <div aria-busy="true" className="cd-skel"><Skeleton lines={5} height={34} /></div>
          : snapshot && visible.length ? visible.map(m => {
            const customized = Object.keys(drafts[m.id] ?? {}).length > 0;
            return (
              <div className={`cd-row cd-row--plain${selected === m.id ? ' is-active' : ''}`} key={m.id}>
                <button type="button" role="option" aria-selected={selected === m.id} className="cd-row-main" onClick={() => setSelected(m.id)}>
                  <span className="cd-row-name">{modelName(m)}</span>
                  <span className="cd-row-id ec-mono"><Masked value={m.id} kind="identifier" mono /></span>
                  <span className="cd-row-chips">
                    {customized ? <Chip size="sm" tone="accent">{t('agents.catalog.customized')}</Chip> : <Chip size="sm" tone="outline">{t('agents.harness.apiSource')}</Chip>}
                    {m.id === snapshot.defaultModel ? <Chip size="sm" tone="ok">{t('agents.harness.defaultModel')}</Chip> : null}
                  </span>
                </button>
              </div>
            );
          }) : <EmptyState compact title={t(snapshot?.models.length ? 'agents.catalog.noMatches' : 'agents.catalog.empty')} />}
      </div>
      <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={loading} disabled={loading || saving} onClick={() => dirty ? setConfirmation('reload') : void load()}>
        {t('agents.catalog.reload')}
      </Button>
    </div>
  );

  const editor = (
    <div className="cd-editor">
      {loading ? <div aria-busy="true"><Skeleton lines={8} height={30} /></div>
        : snapshot && (active || selected === null) ? <fieldset className="cd-fieldset" disabled={saving}>
          <div className="cd-editor-head">
            <h3 className="cd-editor-title ec-mono">{active ? <Masked value={active.id} kind="identifier" mono /> : t('agents.harness.provider')}</h3>
            {active && Array.isArray(active.defaults.input) ? <Chip size="sm" tone="info">{t('agents.harness.apiInput', { value: active.defaults.input.join(', ') })}</Chip>
              : active ? <Chip size="sm" tone="outline">{t('agents.harness.apiInput', { value: t('agents.harness.unknown') })}</Chip> : null}
            <span className="cd-editor-spacer" />
            <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => { if (active) setDrafts(current => ({ ...current, [active.id]: {} })); else setProvider({}); changed(); }}>{t('agents.harness.reset')}</Button>
          </div>
          {active ? null : <p className="cd-source">{t('agents.harness.managedConnection', { url: api === 'anthropic-messages' ? snapshot.baseUrl.replace(/\/v1$/, '') : snapshot.baseUrl })}</p>}
          <HarnessFields key={active?.id ?? 'provider'} group={active ? 'model' : 'provider'} draft={active ? drafts[active.id] ?? {} : provider} defaults={active?.defaults} api={api}
            contextDefault={harnessContextDefault(active?.defaults ?? {}, active ? provider : {})}
            onChange={next => { if (active) setDrafts(current => ({ ...current, [active.id]: next })); else setProvider(next); changed(); }} />
        </fieldset>
          : !error ? <EmptyState compact title={t('sec.agents.catalog.noSelection')} /> : null}
    </div>
  );

  return (
    <>
      <Dialog open size="lg" title={t('agents.harness.title')} onClose={close} dismissible={!saving}
        footer={<CatalogFooter error={snapshot ? error : ''} notice={notice} dirty={dirty} saveHint={t('agents.harness.saveHint')}
          busy={loading || saving} saving={saving} canSave={dirty && !loading && !saving} canReset={!!snapshot}
          onDismissError={() => setError('')} onDismissNotice={() => setNotice('')}
          onResetAll={() => { setDrafts(Object.fromEntries(snapshot!.models.map(m => [m.id, {}]))); setProvider({}); changed(); }}
          onCancel={close} onSave={() => void save()} />}>
        <div className="cd-root">
          {error && !snapshot ? <ErrorState message={<Masked value={error} />} onRetry={() => void load()} /> : (
            <div className="cd-split">{list}{editor}</div>
          )}
        </div>
      </Dialog>
      <CatalogDiscardConfirm open={confirmation !== null} onKeep={() => setConfirmation(null)}
        onDiscard={() => { if (confirmation === 'close') onClose(); else { setConfirmation(null); void load(); } }} />
    </>
  );
}
