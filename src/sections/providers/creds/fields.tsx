/**
 * Form controls of the credential panel, built on kit tokens. Same data semantics as the old settings dialog:
 * model aliases, Claude cloaking, timezone and custom headers all round-trip through authFileSettings drafts.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, Info, Plus, Undo2, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { MessageKey } from '../../../i18n/resources';
import { Button, IconButton } from '../../../ui';
import { isRecord } from '../../../services/managementApi';
import { headerEntries, showsClaudeCredentialSettings } from '../../../components/CredentialAdvancedFields';
import type { BooleanOverride } from '../../../services/authFileSettings';
import './creds.css';

type Advanced = Record<string, unknown>;
type AliasRow = Record<string, unknown>;

export function Field({ label, hint, span = false, children }: { label: string; hint?: string; span?: boolean; children: ReactNode }) {
  return (
    <label className={`ec-cred-field${span ? ' ec-cred-field--span' : ''}`}>
      <span className="ec-cred-field__label">
        {label}
        {hint ? <span className="ec-cred-hint" title={hint} aria-label={hint}><Info size={12} aria-hidden="true" /></span> : null}
      </span>
      {children}
    </label>
  );
}

export function TextField({ label, hint, value, onChange, placeholder, numeric = false, disabled, mono = false, span = false }: {
  label: string; hint?: string; value: string; onChange: (value: string) => void; placeholder?: string;
  numeric?: boolean; disabled?: boolean; mono?: boolean; span?: boolean;
}) {
  return (
    <Field label={label} hint={hint} span={span}>
      <input className={`ec-cred-input${mono ? ' ec-mono' : ''}`} value={value} disabled={disabled} placeholder={placeholder}
        inputMode={numeric ? 'numeric' : undefined} autoComplete="off" spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)} />
    </Field>
  );
}

export function OverrideField({ label, hint, value, onChange, disabled }: {
  label: string; hint?: string; value: BooleanOverride; onChange: (value: BooleanOverride) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Field label={label} hint={hint}>
      <select className="ec-cred-input" value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value as BooleanOverride)}>
        <option value="">{t('authFiles.settings.inherit')}</option>
        <option value="true">{t('common.enable')}</option>
        <option value="false">{t('common.disable')}</option>
      </select>
    </Field>
  );
}

const textValue = (value: unknown) => (typeof value === 'string' ? value : '');
const wordsValue = (value: unknown) => (Array.isArray(value)
  ? value.filter((word): word is string => typeof word === 'string').join(', ')
  : typeof value === 'string' ? value : '');
const aliasRows = (value: unknown): AliasRow[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function withKey(advanced: Advanced, key: string, value: unknown): Advanced {
  const next = { ...advanced };
  if (value === undefined) delete next[key]; else next[key] = value;
  return next;
}

/** Model aliases, Claude cloaking (when relevant) and timezone: the "advanced" JSON-backed fields. */
export function AdvancedFields({ provider, advanced, modelIds, disabled, onChange }: {
  provider: string; advanced: Advanced; modelIds: string[]; disabled?: boolean; onChange: (advanced: Advanced) => void;
}) {
  const { t } = useI18n();
  const aliases = aliasRows(advanced.model_aliases);
  const aliasesSet = Array.isArray(advanced.model_aliases);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [wordsDraft, setWordsDraft] = useState<string | null>(null);
  const listId = `ec-cred-models-${provider || 'x'}`;
  const setField = (key: string, value: unknown) => onChange(withKey(advanced, key, value));
  const updateAlias = (index: number, patch: AliasRow) => setField('model_aliases', aliases.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    const merged = { ...row, ...patch };
    Object.entries(patch).forEach(([key, value]) => { if (value === undefined) delete merged[key]; });
    return merged;
  }));
  const tri = (value: unknown) => (value === true ? 'true' : value === false ? 'false' : '');
  const choice = (label: MessageKey, key: string, options: ReadonlyArray<{ value: string; label: MessageKey }>) => (
    <Field label={t(label)}>
      <select className="ec-cred-input" disabled={disabled} value={options.some((option) => option.value === textValue(advanced[key])) ? textValue(advanced[key]) : ''}
        onChange={(event) => setField(key, event.currentTarget.value || undefined)}>
        <option value="">{t('authFiles.settings.inherit')}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
      </select>
    </Field>
  );
  const boolChoice = (label: MessageKey, key: 'cloak_strict_mode' | 'cloak_cache_user_id') => (
    <Field label={t(label)}>
      <select className="ec-cred-input" disabled={disabled} value={tri(advanced[key])}
        onChange={(event) => setField(key, event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}>
        <option value="">{t('authFiles.settings.inherit')}</option>
        <option value="true">{t('common.enable')}</option>
        <option value="false">{t('common.disable')}</option>
      </select>
    </Field>
  );

  return (
    <>
      <div className="ec-cred-subsection">
        <div className="ec-cred-subsection__head">
          <h4>{t('authFiles.settings.aliases')}</h4>
          <span className="ec-cred-hint" title={t('authFiles.settings.aliasesHint')} aria-label={t('authFiles.settings.aliasesHint')}><Info size={12} aria-hidden="true" /></span>
        </div>
        <datalist id={listId}>{modelIds.map((id) => <option key={id} value={id} />)}</datalist>
        {aliases.map((row, index) => (
          <div className="ec-cred-alias" key={index}>
            <div className="ec-cred-alias__row">
              <input className="ec-cred-input ec-mono" list={listId} aria-label={t('authFiles.settings.aliasUpstream')} placeholder={t('authFiles.settings.aliasModelPlaceholder')}
                value={textValue(row.name)} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={240}
                onChange={(event) => updateAlias(index, { name: event.currentTarget.value })} />
              <span className="ec-cred-alias__arrow" aria-hidden="true">→</span>
              <input className="ec-cred-input ec-mono" aria-label={t('authFiles.settings.aliasClient')} placeholder={t('authFiles.settings.aliasClient')}
                value={textValue(row.alias)} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={240}
                onChange={(event) => updateAlias(index, { alias: event.currentTarget.value })} />
              <IconButton size="sm" label={expanded === index ? t('authFiles.list.collapse') : t('authFiles.list.details')} disabled={disabled}
                aria-expanded={expanded === index} icon={<ChevronDown size={14} className={expanded === index ? 'is-open' : ''} />}
                onClick={() => setExpanded(expanded === index ? null : index)} />
              <IconButton size="sm" label={t('authFiles.settings.aliasRemove', { index: index + 1 })} disabled={disabled} icon={<X size={14} />}
                onClick={() => {
                  setExpanded((current) => (current === index ? null : current !== null && current > index ? current - 1 : current));
                  setField('model_aliases', aliases.filter((_, rowIndex) => rowIndex !== index));
                }} />
            </div>
            {expanded === index ? (
              <div className="ec-cred-alias__more">
                <TextField label={t('authFiles.settings.aliasDisplay')} value={textValue(row['display-name'])} disabled={disabled}
                  onChange={(value) => updateAlias(index, { 'display-name': value.trim() ? value : undefined })} />
                <label className="ec-cred-check"><input type="checkbox" checked={row.fork === true} disabled={disabled}
                  onChange={(event) => updateAlias(index, { fork: event.currentTarget.checked })} />{t('authFiles.settings.aliasFork')}</label>
                <label className="ec-cred-check"><input type="checkbox" checked={row['force-mapping'] === true} disabled={disabled}
                  onChange={(event) => updateAlias(index, { 'force-mapping': event.currentTarget.checked })} />{t('authFiles.settings.aliasForce')}</label>
              </div>
            ) : null}
          </div>
        ))}
        {!aliases.length && aliasesSet ? <p className="ec-cred-note">{t('authFiles.settings.aliasCleared')}</p> : null}
        <div className="ec-cred-inline-actions">
          <Button size="sm" variant="outline" icon={<Plus size={14} />} disabled={disabled}
            onClick={() => setField('model_aliases', [...aliases, { name: '', alias: '' }])}>{t('authFiles.settings.aliasAdd')}</Button>
          {aliasesSet ? <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} disabled={disabled}
            onClick={() => setField('model_aliases', undefined)}>{t('authFiles.settings.aliasInherit')}</Button> : null}
        </div>
      </div>

      {showsClaudeCredentialSettings(provider, advanced) ? (
        <div className="ec-cred-subsection">
          <div className="ec-cred-subsection__head">
            <h4>{t('authFiles.settings.claude')}</h4>
            <span className="ec-cred-hint" title={t('authFiles.settings.claudeHint')} aria-label={t('authFiles.settings.claudeHint')}><Info size={12} aria-hidden="true" /></span>
          </div>
          <div className="ec-cred-grid">
            {choice('authFiles.settings.cloak_mode', 'cloak_mode', [
              { value: 'auto', label: 'authFiles.settings.cloak_mode.auto' },
              { value: 'always', label: 'authFiles.settings.cloak_mode.always' },
              { value: 'never', label: 'authFiles.settings.cloak_mode.never' },
            ])}
            {choice('authFiles.settings.fingerprint_profile', 'fingerprint_profile', [
              { value: 'claude-code-cli', label: 'authFiles.settings.fingerprint_profile.claude-code-cli' },
              { value: 'oauth-cli', label: 'authFiles.settings.fingerprint_profile.oauth-cli' },
            ])}
            {boolChoice('authFiles.settings.cloak_strict_mode', 'cloak_strict_mode')}
            {boolChoice('authFiles.settings.cloak_cache_user_id', 'cloak_cache_user_id')}
            <Field label={t('authFiles.settings.cloak_sensitive_words')} hint={t('authFiles.settings.cloakWordsHint')} span>
              <input className="ec-cred-input" disabled={disabled} autoComplete="off" spellCheck={false}
                placeholder={t('authFiles.settings.cloakWordsPlaceholder')} value={wordsDraft ?? wordsValue(advanced.cloak_sensitive_words)}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  setWordsDraft(text);
                  const words = text.split(',').map((word) => word.trim()).filter(Boolean);
                  setField('cloak_sensitive_words', words.length ? words : undefined);
                }}
                onBlur={() => setWordsDraft(null)} />
            </Field>
          </div>
        </div>
      ) : null}

      <div className="ec-cred-grid">
        <Field label={t('authFiles.settings.timezone')} hint={t('authFiles.settings.timezoneHint')}>
          <input className="ec-cred-input" disabled={disabled} autoComplete="off" spellCheck={false} placeholder={'Asia/Shanghai'}
            value={textValue(advanced.timezone)}
            onChange={(event) => setField('timezone', event.currentTarget.value)}
            onBlur={(event) => setField('timezone', event.currentTarget.value.trim() || undefined)} />
        </Field>
      </div>
    </>
  );
}

/** Custom headers as name/value rows; falls back to a JSON textarea when the stored value is not a flat string map. */
export function HeadersEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const parsed = headerEntries(value);
  const [rows, setRows] = useState<Array<{ name: string; value: string }> | null>(null);
  const visible = rows ?? parsed ?? [];
  const write = (next: Array<{ name: string; value: string }>) => {
    setRows(next);
    const headers: Record<string, string> = {};
    next.forEach((row) => { if (row.name.trim() || row.value.trim()) headers[row.name] = row.value; });
    onChange(JSON.stringify(headers, null, 2));
  };
  if (parsed === null) {
    return (
      <Field label={t('authFiles.settings.headers')} hint={t('authFiles.settings.headersHint')} span>
        <textarea className="ec-cred-input ec-cred-input--area ec-mono" rows={5} value={value} disabled={disabled} spellCheck={false}
          autoComplete="off" onChange={(event) => onChange(event.currentTarget.value)} />
      </Field>
    );
  }
  return (
    <div className="ec-cred-subsection">
      <div className="ec-cred-subsection__head">
        <h4>{t('authFiles.settings.headers')}</h4>
        <span className="ec-cred-hint" title={t('authFiles.settings.headersRowHint')} aria-label={t('authFiles.settings.headersRowHint')}><Info size={12} aria-hidden="true" /></span>
      </div>
      {visible.length === 0 ? <p className="ec-cred-note">{t('authFiles.settings.headersEmpty')}</p> : null}
      {visible.map((row, index) => (
        <div className="ec-cred-header-row" key={index}>
          <input className="ec-cred-input ec-mono" aria-label={t('authFiles.settings.headerName')} placeholder={t('authFiles.settings.headerName')}
            value={row.name} disabled={disabled} autoComplete="off" spellCheck={false}
            onChange={(event) => write(visible.map((item, i) => (i === index ? { ...item, name: event.currentTarget.value } : item)))} />
          <input className="ec-cred-input ec-mono" aria-label={t('authFiles.settings.headerValue')} placeholder={t('authFiles.settings.headerValue')}
            value={row.value} disabled={disabled} autoComplete="off" spellCheck={false}
            onChange={(event) => write(visible.map((item, i) => (i === index ? { ...item, value: event.currentTarget.value } : item)))} />
          <IconButton size="sm" label={t('authFiles.settings.headerRemove', { name: row.name || String(index + 1) })} disabled={disabled}
            icon={<X size={14} />} onClick={() => write(visible.filter((_, i) => i !== index))} />
        </div>
      ))}
      <div className="ec-cred-inline-actions">
        <Button size="sm" variant="outline" icon={<Plus size={14} />} disabled={disabled}
          onClick={() => write([...visible, { name: '', value: '' }])}>{t('authFiles.settings.headerAdd')}</Button>
      </div>
    </div>
  );
}
