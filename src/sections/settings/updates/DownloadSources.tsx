// "Download sources" group: built-in channels + custom HTTPS mirrors, the selected one clearly marked,
// and the explicit opt-in for falling back to mirrors.
import { useRef, useState } from 'react';
import { Globe, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Button, Chip, IconButton, Masked, Toggle } from '../../../ui';
import { SettingRow, SettingsGroup } from '../ui';
import { BUILTIN_SOURCES, DEFAULT_VERSION_DOWNLOAD_SOURCE, downloadSourceLabel, type VersionDownloadSource, type VersionSourceSettings } from './model';

export function DownloadSources({ settings, saving, locked, error, addError, onSelect, onMirrorFallback, onAdd, onRemove, onClearAddError }: {
  settings: VersionSourceSettings | null; saving: boolean; locked: boolean; error: string; addError: string;
  onSelect: (source: VersionDownloadSource) => void; onMirrorFallback: (enabled: boolean) => void; onAdd: (url: string) => Promise<boolean>;
  onRemove: (url: string, wasSelected: boolean) => void; onClearAddError: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = settings?.source ?? DEFAULT_VERSION_DOWNLOAD_SOURCE;
  const disabled = !settings || saving || locked;

  const submit = async () => {
    const url = draft.trim();
    if (!url) return;
    if (!/^https:\/\//i.test(url)) {
      setInvalid(true);
      return;
    }
    if (await onAdd(url)) setDraft('');
  };

  const rowControl = (id: VersionDownloadSource, unavailable?: string) => (
    id === selected
      ? <Chip tone="accent">{t('sec.settings.updates.sources.selected')}</Chip>
      : (
        <span title={unavailable || (locked ? t('sec.settings.updates.sources.locked') : undefined)}>
          <Button size="sm" variant="outline" disabled={disabled || Boolean(unavailable)} onClick={() => onSelect(id)}>{t('sec.settings.updates.sources.use')}</Button>
        </span>
      )
  );

  return (
    <SettingsGroup
      id="updates-sources"
      title={t('sec.settings.updates.sources.title')}
      icon={<Globe size={15} />}
      status={<Chip size="sm" tone="outline">{downloadSourceLabel(selected, t)}</Chip>}
    >
      {error ? <p className="ec-upd-error ec-upd-group-error" role="alert">{error}</p> : null}
      <p className="ec-upd-note ec-upd-group-note" data-testid="updates-integrity-note">{t('sec.settings.updates.sources.integrityNote')}</p>
      {BUILTIN_SOURCES.map((entry) => {
        const unavailable = entry.id === 'gitcode' && settings?.gitcodeAvailable === false ? t('kernel.versions.gitcodeUnavailable') : '';
        return (
          <div key={entry.id} className={`ec-set-row ec-upd-source${entry.id === selected ? ' is-selected' : ''}`} data-source={entry.id} data-selected={entry.id === selected ? 'true' : undefined}>
            <div className="ec-set-row-label">
              <span className="ec-upd-radio" aria-hidden="true" />
              <span className="ec-upd-source-name">{t(entry.labelKey)}</span>
              <span className="ec-upd-source-host ec-mono">{entry.host}</span>
              {unavailable ? <Chip size="sm" tone="warn">{unavailable}</Chip> : null}
            </div>
            <div className="ec-set-row-control">{rowControl(entry.id, unavailable)}</div>
          </div>
        );
      })}
      {settings?.customMirrors.map((url) => {
        const id = `custom:${url}`;
        return (
          <div key={url} className={`ec-set-row ec-upd-source${id === selected ? ' is-selected' : ''}`} data-source={id} data-selected={id === selected ? 'true' : undefined}>
            <div className="ec-set-row-label">
              <span className="ec-upd-radio" aria-hidden="true" />
              <Chip size="sm" tone="outline">{t('sec.settings.updates.sources.custom')}</Chip>
              <span className="ec-upd-source-url ec-mono"><Masked value={url} kind="identifier" mono /></span>
            </div>
            <div className="ec-set-row-control">
              {rowControl(id)}
              <IconButton size="sm" label={t('kernel.versions.customMirrorRemove')} icon={<Trash2 size={14} />} disabled={saving || locked} onClick={() => onRemove(url, id === selected)} />
            </div>
          </div>
        );
      })}
      <SettingRow label={t('sec.settings.updates.sources.fallbackLabel')} hint={t('sec.settings.updates.sources.fallbackHint')}>
        <Toggle
          checked={settings?.mirrorFallback ?? false}
          label={t('sec.settings.updates.sources.fallbackLabel')}
          disabled={disabled}
          onChange={onMirrorFallback}
        />
      </SettingRow>
      <SettingRow
        label={t('sec.settings.updates.sources.addLabel')}
        hint={t('sec.settings.updates.sources.addHint')}
        htmlFor="updates-mirror-input"
        stacked
        error={invalid ? t('sec.settings.updates.sources.invalid') : addError}
      >
        <form
          className="ec-upd-add"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            id="updates-mirror-input"
            ref={inputRef}
            type="url"
            className="ec-set-input is-wide is-mono"
            value={draft}
            disabled={disabled}
            aria-invalid={invalid || Boolean(addError)}
            placeholder={t('kernel.versions.customMirrorPlaceholder')}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
              onClearAddError();
            }}
          />
          <Button type="submit" size="sm" variant="primary" icon={<Plus size={14} />} loading={saving && Boolean(draft)} disabled={disabled || !draft.trim()}>
            {t('kernel.versions.customMirrorConfirm')}
          </Button>
        </form>
      </SettingRow>
    </SettingsGroup>
  );
}
