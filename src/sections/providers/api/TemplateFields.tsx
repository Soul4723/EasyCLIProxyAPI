// Kit-styled port of components/ProviderTemplateFields.tsx and ProviderGroupKeysEditor.tsx (same fields, same value
// shapes; copy comes from i18n/providerTemplate). Used by ApiProviderForm.
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { providerText, type ProviderTemplateMessage } from '../../../i18n/providerTemplate';
import { isRecord, readString } from '../../../services/managementApi';
import { providerKeyDraft, type ProviderKeyDraft } from '../../../services/providerGroups';
import { Button, IconButton } from '../../../ui';
import { CheckField, Disclosure, Field, FormGrid, SelectInput, TextArea, TextInput } from './fields';

type Value = Record<string, unknown>;
type Change = (value: Value) => void;

const changed = (value: Value, field: string, next: unknown): Value => {
  const result = { ...value };
  if (next === undefined) delete result[field]; else result[field] = next;
  return result;
};
const lines = (value: unknown) => Array.isArray(value) ? value.map(String).join('\n') : '';

export function ProviderField({ value, onChange, field, label, kind = 'boolean', initial, hint, choices }: {
  value: Value; onChange: Change; field: string; label: ProviderTemplateMessage;
  kind?: 'boolean' | 'text' | 'number' | 'lines' | 'select'; initial?: unknown; hint?: ProviderTemplateMessage;
  choices?: { value: string; label: string }[];
}) {
  const { locale } = useI18n();
  const p = (key: ProviderTemplateMessage) => providerText(key, locale);
  const current = value[field];
  const enabled = current != null;
  const set = (next: unknown) => onChange(changed(value, field, next));
  if (kind === 'boolean') {
    return (
      <Field label={p(label)} hint={hint ? p(hint) : undefined}>
        <SelectInput aria-label={p(label)} value={enabled ? String(current) : ''} onChange={(event) => set(event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}>
          <option value="">{p('inherit')}</option><option value="true">{p('enabled')}</option><option value="false">{p('disabled')}</option>
        </SelectInput>
      </Field>
    );
  }
  return (
    <div className="ec-api-field ec-api-field--optional">
      <CheckField
        label={p(label)}
        checked={enabled}
        onChange={(checked) => set(checked ? structuredClone(initial ?? (kind === 'number' ? 0 : kind === 'lines' ? [] : '')) : undefined)}
      />
      {enabled ? kind === 'lines' ? (
        <TextArea aria-label={p(label)} rows={3} value={lines(current)}
          onChange={(event) => set(event.currentTarget.value.split(/\r?\n/))}
          onBlur={(event) => set(event.currentTarget.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} />
      ) : kind === 'select' ? (
        <SelectInput aria-label={p(label)} value={String(current)} onChange={(event) => set(event.currentTarget.value)}>
          {!choices?.some((choice) => choice.value === current) ? <option value={String(current)}>{String(current)}</option> : null}
          {choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </SelectInput>
      ) : (
        <TextInput aria-label={p(label)} type={kind} step={kind === 'number' ? '1' : undefined} value={String(current)}
          onChange={(event) => set(kind === 'number' && event.currentTarget.value !== '' ? Number(event.currentTarget.value) : event.currentTarget.value)} />
      ) : null}
      {hint ? <small className="ec-api-field__hint">{p(hint)}</small> : null}
    </div>
  );
}

export function ProviderErrorRules({ value, onChange, inherited }: { value: Value; onChange: Change; inherited?: unknown }) {
  const { locale } = useI18n();
  const p = (key: ProviderTemplateMessage) => providerText(key, locale);
  const field = 'request-scoped-errors';
  const rules = Array.isArray(value[field]) ? value[field] as unknown[] : [];
  const set = (next: unknown) => onChange(changed(value, field, next));
  const actions = ['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'] as const;
  return (
    <Disclosure nested title={p('errors')} meta={value[field] != null ? rules.length : undefined}>
      <small className="ec-api-field__hint">{p('errorsHint')}</small>
      <CheckField label={p('configure')} checked={value[field] != null}
        onChange={(checked) => set(checked ? structuredClone(inherited ?? []) : undefined)} />
      {value[field] != null ? (
        <div className="ec-api-rules">
          {rules.map((raw, index) => {
            const rule = isRecord(raw) ? raw : {};
            const update = (next: Value) => set(rules.map((item, i) => i === index ? next : item));
            return (
              <fieldset key={index} className="ec-api-rule">
                <legend>{index + 1}</legend>
                <FormGrid>
                  <Field label={p('status')}>
                    <TextInput aria-label={p('status')} type="number" min="100" max="599" step="1" value={String(rule.status ?? '')}
                      onChange={(event) => update({ ...rule, status: event.currentTarget.value === '' ? '' : Number(event.currentTarget.value) })} />
                  </Field>
                  <Field label={p('action')}>
                    <SelectInput aria-label={p('action')} value={readString(rule, 'action')} onChange={(event) => update({ ...rule, action: event.currentTarget.value })}>
                      {!actions.some((action) => action === rule.action) ? <option value={readString(rule, 'action')}>{readString(rule, 'action')}</option> : null}
                      {actions.map((action) => <option key={action} value={action}>{p(action)}</option>)}
                    </SelectInput>
                  </Field>
                  <ProviderField value={rule} onChange={update} field="match" label="match" kind="lines" />
                  <ProviderField value={rule} onChange={update} field="match-regexr" label="regex" kind="lines" />
                </FormGrid>
                <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => set(rules.filter((_, i) => i !== index))}>{p('remove')}</Button>
              </fieldset>
            );
          })}
          <Button size="xs" icon={<Plus size={12} />} onClick={() => set([...rules, { status: 400, action: 'stop' }])}>{p('addRule')}</Button>
        </div>
      ) : null}
    </Disclosure>
  );
}

export function ProviderGroupTemplateFields({ value, onChange, section, includeErrors = true }: { value: Value; onChange: Change; section: string; includeErrors?: boolean }) {
  return (
    <>
      <ProviderField value={value} onChange={onChange} field="request-retry" label="retry" kind="number" initial={0} hint="retryHint" />
      {section === 'openai-compatibility' ? <ProviderField value={value} onChange={onChange} field="support-prompt-cache-key" label="promptCache" /> : null}
      {includeErrors && section !== 'vertex-api-key' ? <ProviderErrorRules value={value} onChange={onChange} /> : null}
    </>
  );
}

export function ProviderKeyTemplateFields({ value, onChange, section, inherited }: { value: Value; onChange: Change; section: string; inherited: Value }) {
  const { locale } = useI18n();
  return (
    <>
      {!['vertex-api-key', 'openai-compatibility'].includes(section) ? <ProviderErrorRules value={value} onChange={onChange} inherited={inherited['request-scoped-errors']} /> : null}
      {section === 'codex-api-key' ? (
        <FormGrid>
          <ProviderField value={value} onChange={onChange} field="disable-codex-cloaking" label="noCloak" />
          <ProviderField value={value} onChange={onChange} field="alpha-search" label="alpha" />
        </FormGrid>
      ) : null}
      {section === 'claude-api-key' ? (
        <FormGrid>
          <ProviderField value={value} onChange={onChange} field="rebuild-mid-system-message" label="rebuild" />
          <ProviderField value={value} onChange={onChange} field="fingerprint-profile" label="fingerprint" kind="select" choices={[
            { value: '', label: providerText('caller', locale) }, { value: 'claude-code-cli', label: 'Claude Code CLI' },
          ]} />
          <ProviderField value={value} onChange={onChange} field="experimental-cch-signing" label="cch" hint="deprecated" />
        </FormGrid>
      ) : null}
    </>
  );
}

/** Per-model options (display name, context, thinking, …) behind a disclosure under the model row. */
export function ProviderModelFields({ value, onChange, section, children }: { value: Value; onChange: Change; section: string; children?: ReactNode }) {
  const { locale } = useI18n();
  const thinking = isRecord(value.thinking) ? value.thinking : {};
  const setThinking = (next: Value) => onChange({ ...value, thinking: next });
  return (
    <Disclosure nested title={providerText('options', locale)}>
      <small className="ec-api-field__hint">{providerText('modelHint', locale)}</small>
      <FormGrid>
        <ProviderField value={value} onChange={onChange} field="display-name" label="display" kind="text" />
        {section !== 'vertex-api-key' ? (
          <>
            <ProviderField value={value} onChange={onChange} field="max-context-length" label="context" kind="number" />
            <ProviderField value={value} onChange={onChange} field="is-compat" label="compat" />
          </>
        ) : null}
        <ProviderField value={value} onChange={onChange} field="force-mapping" label="force" />
        {['codex-api-key', 'xai-api-key', 'meta-api-key'].includes(section) ? <ProviderField value={value} onChange={onChange} field="support-configuration-update" label="configuration" /> : null}
        {section === 'openai-compatibility' ? (
          <>
            <ProviderField value={value} onChange={onChange} field="image" label="image" hint="imageHint" />
            <ProviderField value={value} onChange={onChange} field="input-modalities" label="input" kind="lines" hint="linesHint" />
            <ProviderField value={value} onChange={onChange} field="output-modalities" label="output" kind="lines" hint="linesHint" />
            <ProviderField value={value} onChange={onChange} field="use-max-completion-tokens" label="completion" />
          </>
        ) : null}
      </FormGrid>
      <CheckField label={providerText('thinking', locale)} checked={value.thinking != null}
        onChange={(checked) => onChange(changed(value, 'thinking', checked ? {} : undefined))} />
      {value.thinking != null ? (
        <FormGrid>
          <ProviderField value={thinking} onChange={setThinking} field="levels" label="levels" kind="lines" hint="linesHint" />
          <ProviderField value={thinking} onChange={setThinking} field="min" label="min" kind="number" />
          <ProviderField value={thinking} onChange={setThinking} field="max" label="max" kind="number" />
          <ProviderField value={thinking} onChange={setThinking} field="zero-allowed" label="zero" />
          <ProviderField value={thinking} onChange={setThinking} field="dynamic-allowed" label="dynamic" />
        </FormGrid>
      ) : null}
      {children}
    </Disclosure>
  );
}

/** Keys of a native OpenAI-compatible key group: one row per key with a masked input and per-key proxy/weight. */
export function GroupKeysEditor({ keys, disabled, onChange }: {
  keys: ProviderKeyDraft[];
  disabled: boolean;
  onChange: (keys: ProviderKeyDraft[]) => void;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const set = (id: string, field: string, value: unknown) => {
    onChange(keys.map((draft) => {
      if (draft.id !== id) return draft;
      const next = { ...draft.value };
      if (value === undefined) delete next[field];
      else next[field] = value;
      const text = { ...draft.text };
      delete text[field];
      return { ...draft, value: next, text };
    }));
  };

  return (
    <div className="ec-api-keys" role="group" aria-label={t('apiAccess.entries.keys')}>
      <div className="ec-api-keys__head">
        <strong>{t('apiAccess.entries.keys')}</strong>
        <Button size="xs" icon={<Plus size={12} />} disabled={disabled} onClick={() => onChange([...keys, providerKeyDraft({ 'api-key': '' })])}>
          {t('apiAccess.entries.addKey')}
        </Button>
      </div>
      {!keys.length ? <small className="ec-api-field__hint">{t('apiAccess.entries.emptyKeys')}</small> : null}
      {keys.map((draft, index) => {
        const key = draft.value;
        const isVisible = Boolean(visible[draft.id]);
        return (
          <fieldset className="ec-api-key" key={draft.id} disabled={disabled}>
            <legend>{t('apiAccess.entries.keyNumber', { number: index + 1 })}</legend>
            <div className="ec-api-key__main">
              <TextInput
                type={isVisible ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('apiAccess.entries.keyNumber', { number: index + 1 })}
                value={readString(key, 'api-key')}
                placeholder="sk-..."
                onChange={(event) => set(draft.id, 'api-key', event.currentTarget.value)}
              />
              <IconButton
                size="sm"
                label={t(isVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
                icon={isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                active={isVisible}
                onClick={() => setVisible((state) => ({ ...state, [draft.id]: !state[draft.id] }))}
              />
              <IconButton
                size="sm"
                label={t('apiAccess.entries.removeKey', { number: index + 1 })}
                icon={<Trash2 size={14} />}
                onClick={() => onChange(keys.filter((item) => item.id !== draft.id))}
              />
            </div>
            <Disclosure nested title={t('apiAccess.entries.keySettings')}>
              <FormGrid>
                <Field label={t('apiAccess.field.proxyUrl')}>
                  <TextInput value={readString(key, 'proxy-url')} placeholder="socks5://127.0.0.1:1080"
                    onChange={(event) => set(draft.id, 'proxy-url', event.currentTarget.value || undefined)} />
                </Field>
                <Field label={t('apiAccess.entries.weight')}>
                  <TextInput type="number" max="1000000" step="1" value={key.weight == null ? '' : String(key.weight)} placeholder="1"
                    onChange={(event) => set(draft.id, 'weight', event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value))} />
                </Field>
              </FormGrid>
            </Disclosure>
          </fieldset>
        );
      })}
    </div>
  );
}
