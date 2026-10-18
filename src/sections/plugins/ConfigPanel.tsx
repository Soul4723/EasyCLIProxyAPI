import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { pluginConfigText, type PluginConfigMessage } from '../../i18n/pluginConfig';
import { pluginsApi, type PluginConfigField, type PluginConfigObject, type PluginListEntry } from '../../services/plugins';
import {
  buildPluginConfigDraft, buildPluginConfigPatch, normalizePluginConfigFieldType,
  type PluginConfigDraft, type PluginDraftValue,
} from '../../services/pluginConfigDraft';
import { Button, Chip, Masked, SidePanel, Skeleton, Toggle } from '../../ui';
import { Banner, PluginTile, Scope } from './parts';
import { errorMessage } from './usePlugins';

function customConfig(config: PluginConfigObject): PluginConfigObject {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'enabled' && key !== 'priority'));
}

/**
 * Typed plugin configuration in a side panel (the old PluginConfigDialog, same draft/patch services): enabled, priority,
 * one input per declared field (or a raw JSON editor when the plugin declares none), unsaved-changes guard.
 * Props: plugin, onClose, onSaved (called after a successful write, before onClose).
 */
export function ConfigPanel({ plugin, onClose, onSaved }: {
  plugin: PluginListEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const pt = (key: PluginConfigMessage) => pluginConfigText(key, locale);
  const id = useId();
  const [draft, setDraft] = useState<PluginConfigDraft | null>(null);
  const [raw, setRaw] = useState('{}');
  const [original, setOriginal] = useState<PluginConfigObject>({});
  const [rawTouched, setRawTouched] = useState(false);
  const [rawError, setRawError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const pending = useRef(false);
  const fields = useMemo(() => plugin.configFields.filter(field => field.name !== 'enabled' && field.name !== 'priority'), [plugin.configFields]);

  useEffect(() => {
    const generation = ++request.current;
    setLoading(true); setDraft(null); setError(''); setRawError(''); setDiscard(false);
    setRawTouched(false);
    void pluginsApi.getConfig(plugin.id).then(config => {
      if (request.current !== generation) return;
      setDraft(buildPluginConfigDraft({ enabled: plugin.enabled, configFields: fields }, config));
      const custom = customConfig(config);
      setOriginal(custom);
      setRaw(JSON.stringify(custom, null, 2));
    }).catch(reason => {
      if (request.current === generation) setError(errorMessage(reason));
    }).finally(() => {
      if (request.current === generation) setLoading(false);
    });
    return () => { request.current += 1; };
  }, [plugin.id, plugin.enabled, fields, attempt]);

  const dirty = Boolean(draft && (draft.enabledTouched || draft.priorityTouched || Object.values(draft.touchedFields).some(Boolean) || rawTouched));
  const close = () => {
    if (pending.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const changeDraft = (updater: (current: PluginConfigDraft) => PluginConfigDraft) => {
    setDraft(current => current ? updater(current) : current);
    setError(''); setDiscard(false);
  };
  const changeField = (name: string, value: PluginDraftValue) => changeDraft(current => ({
    ...current,
    values: { ...current.values, [name]: value },
    touchedFields: { ...current.touchedFields, [name]: true },
    errors: { ...current.errors, [name]: '' },
  }));

  const save = async () => {
    if (!draft || loading || pending.current || !dirty) return;
    const { patch, errors } = buildPluginConfigPatch(draft, fields, key => pt(key.replace('plugin_management.', '') as PluginConfigMessage));
    const removeKeys: string[] = [];
    let nextRawError = '';
    if (!fields.length && rawTouched) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) nextRawError = pt('expected_object');
        else if (Object.prototype.hasOwnProperty.call(parsed, 'enabled') || Object.prototype.hasOwnProperty.call(parsed, 'priority')) nextRawError = pt('reserved');
        else {
          const custom = parsed as PluginConfigObject;
          for (const key of new Set([...Object.keys(original), ...Object.keys(custom)])) {
            const removed = !Object.prototype.hasOwnProperty.call(custom, key);
            if (removed) removeKeys.push(key);
            else if (JSON.stringify(original[key]) !== JSON.stringify(custom[key]))
              Object.defineProperty(patch, key, { value: custom[key], enumerable: true, configurable: true, writable: true });
          }
        }
      } catch { nextRawError = pt('invalid_json'); }
    }
    setDraft(current => current ? { ...current, errors } : current);
    setRawError(nextRawError);
    if (Object.keys(errors).length || nextRawError) {
      setError(pt('invalid'));
      window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (!Object.keys(patch).length && !removeKeys.length) { onClose(); return; }
    pending.current = true;
    setSaving(true); setError('');
    const generation = request.current;
    try {
      await pluginsApi.patchConfig(plugin.id, patch, !fields.length && rawTouched ? { nullMeansDelete: false, removeKeys } : undefined);
      if (request.current === generation) { onSaved(); onClose(); }
    } catch (reason) {
      if (request.current === generation) setError(`${pt('saveFailed')}: ${errorMessage(reason)}`);
    } finally {
      pending.current = false;
      if (request.current === generation) setSaving(false);
    }
  };

  const renderField = (field: PluginConfigField, index: number) => {
    if (!draft) return null;
    const type = normalizePluginConfigFieldType(field);
    const value = draft.values[field.name];
    const fieldId = `${id}-field-${index}`;
    const fieldError = Object.prototype.hasOwnProperty.call(draft.errors, field.name) ? draft.errors[field.name] : '';
    const inputProps = {
      id: fieldId,
      'aria-invalid': Boolean(fieldError),
      'aria-describedby': `${fieldId}-hint${fieldError ? ` ${fieldId}-error` : ''}`,
    };
    return <div className="pl-field" key={field.name}>
      <label className="pl-field-label" htmlFor={fieldId}><span className="pl-field-name">{field.name}</span><Chip size="sm" tone="outline">{type}</Chip></label>
      {type === 'boolean' ? <select className="pl-select pl-select--full" {...inputProps} value={draft.touchedFields[field.name] !== true && typeof original[field.name] !== 'boolean' ? '' : value === true ? 'true' : 'false'} onChange={event => changeField(field.name, event.currentTarget.value === 'true')}>
        <option value="" disabled>{pt('inherit')}</option>
        <option value="true">{t('common.enable')}</option><option value="false">{t('common.disable')}</option>
      </select> : type === 'enum' ? <select className="pl-select pl-select--full" {...inputProps} value={typeof value === 'string' ? value : ''} onChange={event => changeField(field.name, event.currentTarget.value)}>
        <option value="">{pt('inherit')}</option>
        {typeof value === 'string' && value && !field.enumValues.includes(value) ? <option value={value}>{value}</option> : null}
        {field.enumValues.map(option => <option key={option} value={option}>{option}</option>)}
      </select> : type === 'array' || type === 'object' ? <textarea className="pl-input pl-input--mono pl-textarea" {...inputProps} rows={5} spellCheck={false} autoComplete="off" value={typeof value === 'string' ? value : ''} placeholder={type === 'array' ? '[]' : '{}'} onChange={event => changeField(field.name, event.currentTarget.value)} />
        : <input className="pl-input" {...inputProps} type="text" inputMode={type === 'number' ? 'decimal' : type === 'integer' ? 'numeric' : undefined} autoComplete="off" spellCheck={false} value={typeof value === 'string' ? value : ''} onChange={event => changeField(field.name, event.currentTarget.value)} />}
      {field.description ? <small className="pl-field-hint" id={`${fieldId}-hint`}>{field.description}</small> : <span id={`${fieldId}-hint`} />}
      {fieldError ? <small className="pl-field-error" id={`${fieldId}-error`}>{fieldError}</small> : null}
    </div>;
  };

  const title = plugin.metadata?.name || plugin.id;
  return (
    <SidePanel open onClose={close} width={480}
      title={<Scope><span className="pl-dialog-title"><PluginTile size={28} />{pt('title')}</span></Scope>}
      subtitle={<Masked value={title} />}
      footer={<Scope><div className="pl-panel-foot">
        {error ? <Banner tone="error"><Masked value={`${!draft && !loading ? `${pt('loadFailed')}: ` : ''}${error}`} /></Banner> : null}
        {discard ? <Banner tone="warn" action={<>
          <Button size="sm" variant="secondary" onClick={() => setDiscard(false)}>{pt('keepEditing')}</Button>
          <Button size="sm" variant="danger" onClick={onClose}>{pt('discard')}</Button>
        </>}>{pt('unsaved')}</Banner> : null}
        <div className="pl-panel-actions">
          <Button variant="secondary" disabled={saving} onClick={close}>{t('common.cancel')}</Button>
          {!loading && !draft
            ? <Button variant="primary" onClick={() => setAttempt(value => value + 1)}>{pt('retry')}</Button>
            : <Button variant="primary" loading={saving} disabled={loading || !dirty} onClick={() => void save()}>{t(saving ? 'common.saving' : 'common.save')}</Button>}
        </div>
      </div></Scope>}>
      <Scope><div ref={panelRef} className="pl-form" aria-busy={loading || saving}>
        {loading ? <><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} lines={2} /></> : draft ? <>
          <div className="pl-field pl-field--row">
            <span className="pl-field-label">{pt('enabled')}</span>
            <Toggle checked={draft.enabled} label={pt('enabled')} disabled={saving} onChange={checked => changeDraft(current => ({ ...current, enabled: checked, enabledTouched: true }))} />
          </div>
          <small className="pl-field-hint">{pt('enabledHint')}</small>
          <div className="pl-field">
            <label className="pl-field-label" htmlFor={`${id}-priority`}>{pt('priority')}</label>
            <input id={`${id}-priority`} className="pl-input pl-input--mono" type="text" inputMode="numeric" disabled={saving} value={draft.priority}
              aria-invalid={Boolean(draft.errors.priority)}
              onChange={event => { const value = event.currentTarget.value; changeDraft(current => ({ ...current, priority: value, priorityTouched: true, errors: { ...current.errors, priority: '' } })); }} />
            <small className="pl-field-hint">{pt('priorityHint')}</small>
            {draft.errors.priority ? <small className="pl-field-error">{draft.errors.priority}</small> : null}
          </div>
          {fields.length ? <section className="pl-fieldset">
            <h3 className="pl-fieldset-title">{pt('fields')}</h3>
            <small className="pl-field-hint">{pt('fieldsHint')}</small>
            {fields.map(renderField)}
          </section> : <div className="pl-field pl-fieldset">
            <label className="pl-field-label" htmlFor={`${id}-raw`}>{pt('raw')}</label>
            <textarea id={`${id}-raw`} className="pl-input pl-input--mono pl-textarea" rows={10} value={raw} disabled={saving} spellCheck={false} autoComplete="off" aria-invalid={Boolean(rawError)}
              onChange={event => { setRaw(event.currentTarget.value); setRawTouched(true); setRawError(''); setError(''); setDiscard(false); }} />
            {rawError ? <small className="pl-field-error">{rawError}</small> : <small className="pl-field-hint">{pt('rawHint')}</small>}
          </div>}
        </> : null}
      </div></Scope>
    </SidePanel>
  );
}
