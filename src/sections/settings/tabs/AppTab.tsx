import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../../services/documentTarget';
import { getVersion } from '../../../services/platform';
import { Info, Palette, PanelTop, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMode } from '../../../privacy';
import { AppearanceControls } from '../../../shell/AppMenu';
import { routeHref } from '../../../shell/router';
import { Chip, ErrorState, Skeleton, Toggle } from '../../../ui';
import { SaveBar, SettingRow, SettingsGroup, useDraft, useReportDirty } from '../ui';
import './AppTab.css';

type CloseBehavior = 'ask' | 'exit' | 'minimize-to-tray';
type SoftwareSettings = {
  closeBehavior: CloseBehavior;
  autostartEnabled: boolean;
  startCoreOnLaunch: boolean;
  silentStartEnabled: boolean;
  defaultTerminal: string;
  availableTerminals: { id: string; label: string }[];
};
type SoftwareDraft = Omit<SoftwareSettings, 'availableTerminals'>;

const toDraft = (settings: SoftwareSettings): SoftwareDraft => ({
  closeBehavior: settings.closeBehavior,
  autostartEnabled: settings.autostartEnabled,
  startCoreOnLaunch: settings.startCoreOnLaunch,
  silentStartEnabled: settings.silentStartEnabled,
  defaultTerminal: settings.defaultTerminal,
});

export function AppTab() {
  const { t } = useI18n();
  const [privacy, setPrivacy] = usePrivacyMode();
  const [software, setSoftware] = useState<SoftwareSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const value = await invoke<SoftwareSettings>('get_software_settings');
      if (alive.current) { setSoftware(value); setLoadError(''); }
    } catch (cause) { if (alive.current) setLoadError(String(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void getVersion().then((value) => { if (alive.current) setVersion(value); }).catch(() => undefined); }, []);

  const saved = useMemo(() => (software ? toDraft(software) : null), [software]);
  const { draft, setDraft, reset } = useDraft<SoftwareDraft>(saved);
  const count = draft && saved ? (Object.keys(saved) as (keyof SoftwareDraft)[]).filter((key) => draft[key] !== saved[key]).length : 0;
  useReportDirty('app', count > 0);

  const edit = (patch: Partial<SoftwareDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setJustSaved(false); setSaveError('');
  };

  const save = async () => {
    if (!draft || busy || count === 0) return;
    setBusy(true); setSaveError('');
    try {
      const result = await invoke<SoftwareSettings>('save_software_settings', { settings: draft });
      setSoftware(result); setJustSaved(true);
    } catch (cause) {
      setSaveError(t('config.error.saveFailed', { error: String(cause) }));
      void load();
    } finally { setBusy(false); }
  };

  const versionChip = version ? (
    <a className="ec-app-version" href={routeHref('settings', 'updates')} title={t('sec.settings.app.versionLink')} aria-label={`${t('sec.settings.app.version')} ${version} · ${t('sec.settings.app.versionLink')}`}>
      <Chip size="sm" tone="outline">{`v${version}`}</Chip>
    </a>
  ) : null;

  const startup = () => {
    if (loadError && !software) return <ErrorState title={t('sec.settings.app.loadFailed')} message={loadError} onRetry={() => void load()} />;
    if (!software || !draft) return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={4} /></div>;
    const toggle = (key: 'autostartEnabled' | 'startCoreOnLaunch' | 'silentStartEnabled', label: string, hint: string) => (
      <SettingRow label={label} hint={hint}>
        <Toggle checked={draft[key]} label={label} disabled={busy} onChange={(next) => edit({ [key]: next })} />
      </SettingRow>
    );
    return (
      <>
        {toggle('autostartEnabled', t('config.software.autostart'), t('config.software.autostartDescription'))}
        {toggle('startCoreOnLaunch', t('config.software.startCoreOnLaunch'), t('config.software.startCoreOnLaunchDescription'))}
        {toggle('silentStartEnabled', t('config.software.silentStart'), t('config.software.silentStartDescription'))}
        <SettingRow label={t('config.software.closeBehavior')} hint={t('config.software.closeBehaviorDescription')} htmlFor="app-close-behavior">
          <select id="app-close-behavior" className="ec-set-input" value={draft.closeBehavior} disabled={busy}
            onChange={(event) => edit({ closeBehavior: event.currentTarget.value as CloseBehavior })}>
            <option value="ask">{t('config.software.behavior.ask')}</option>
            <option value="minimize-to-tray">{t('config.software.behavior.minimize')}</option>
            <option value="exit">{t('config.software.behavior.exit')}</option>
          </select>
        </SettingRow>
        <SettingRow label={t('config.software.defaultTerminal')} hint={t('config.software.defaultTerminalDescription')} htmlFor="app-default-terminal">
          <select id="app-default-terminal" className="ec-set-input" value={draft.defaultTerminal} disabled={busy}
            onChange={(event) => edit({ defaultTerminal: event.currentTarget.value })}>
            {software.availableTerminals.map((terminal) => (
              <option value={terminal.id} key={terminal.id}>{terminal.id === 'auto' ? t('config.software.terminal.auto') : terminal.label}</option>
            ))}
          </select>
        </SettingRow>
      </>
    );
  };

  return (
    <div className="ec-app-tab">
      <SettingsGroup title={t('sec.settings.app.groupAppearance')} icon={<Palette size={16} />}>
        <div className="ec-app-appearance"><AppearanceControls /></div>
      </SettingsGroup>

      <SettingsGroup title={t('sec.settings.app.groupPrivacy')} icon={<ShieldCheck size={16} />}>
        <SettingRow label={t('app.privacy.label')} hint={t('sec.settings.app.privacyHint')} effect="instant">
          <Toggle checked={privacy} label={t('app.privacy.label')} onChange={setPrivacy} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('sec.settings.app.groupStartup')} icon={<PanelTop size={16} />}>
        {startup()}
      </SettingsGroup>

      {versionChip ? (
        <SettingsGroup title={t('sec.settings.app.groupAbout')} icon={<Info size={16} />}>
          <SettingRow label={t('sec.settings.app.version')}>{versionChip}</SettingRow>
        </SettingsGroup>
      ) : null}

      <SaveBar
        count={count}
        busy={busy}
        error={saveError}
        saved={justSaved}
        onSave={() => void save()}
        onDiscard={() => { reset(); setSaveError(''); setJustSaved(false); }}
      />
    </div>
  );
}
