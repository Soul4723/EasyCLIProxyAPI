import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '../../../services/documentTarget';
import { listen, open } from '../../../services/platform';
import { FolderOpen, Globe, Link2, LockKeyhole, Network, Wifi } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useCoreRuntime, type CoreStatus } from '../../../coreRuntime';
import { Button, Chip, ErrorState, Skeleton, Toggle } from '../../../ui';
import { useCoreConfig, type CoreConfigSettings } from '../coreConfig';
import { SaveBar, SettingRow, SettingsGroup, useReportDirty } from '../ui';
import { useFieldDrafts } from '../useFieldDrafts';
import { useRequestGuard } from '../useRequestGuard';
import './NetworkTab.css';

type TlsSettings = { enabled: boolean; cert: string; key: string };
type Notice = 'restarted' | 'nextStart' | 'remote' | 'applied';

const isLoopbackHost = (host: string) => {
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || value.startsWith('127.');
};

export function NetworkTab() {
  const { t } = useI18n();
  const { settings, loading, error, reload, apply } = useCoreConfig();
  const { status, publishStatus, refreshStatus } = useCoreRuntime();
  const remote = status?.connectionMode === 'remote';

  const [tls, setTls] = useState<TlsSettings | null>(null);
  const [tlsLoading, setTlsLoading] = useState(true);
  const [tlsLoadError, setTlsLoadError] = useState('');
  const tlsRequests = useRequestGuard();
  const loadTls = useCallback(async () => {
    const isCurrent = tlsRequests.begin();
    try {
      const value = await invoke<TlsSettings>('get_core_tls_settings');
      if (!isCurrent()) return;
      setTls(value);
      setTlsLoadError('');
    } catch (cause) {
      if (isCurrent()) setTlsLoadError(String(cause));
    } finally {
      if (isCurrent()) setTlsLoading(false);
    }
  }, [tlsRequests]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void loadTls();
    void listen('config-files-changed', () => { if (!disposed) void loadTls(); }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, [loadTls]);

  const tlsAvailable = tls !== null;
  const saved = useMemo(() => (settings ? {
    host: settings.host,
    port: String(settings.port),
    proxyOverride: settings.proxyOverride,
    proxyUrl: settings.proxyUrl,
    tlsEnabled: tls?.enabled ?? false,
    tlsCert: tls?.cert ?? '',
    tlsKey: tls?.key ?? '',
  } : null), [settings, tls]);
  const { draft, set, reset, dirty: allDirty } = useFieldDrafts(saved);
  const dirty = tlsAvailable ? allDirty : allDirty.filter((key) => !key.startsWith('tls'));
  useReportDirty('network', dirty.length > 0);

  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<'cert' | 'key' | null>(null);
  const [saveError, setSaveError] = useState('');
  const [portError, setPortError] = useState('');
  const [tlsError, setTlsError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  if (loading && !settings) return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={5} /></div>;
  if (!settings || !draft) return <ErrorState title={t('sec.settings.loadFailed')} message={error} onRetry={() => void reload()} />;

  const edit = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    set(key, value);
    setNotice(null);
    setSaveError('');
    if (key === 'port') setPortError('');
    if (String(key).startsWith('tls')) setTlsError('');
  };

  const lan = !isLoopbackHost(draft.host);
  const tlsControlsDisabled = busy || !tlsAvailable || picking !== null;

  const pickFile = async (target: 'cert' | 'key') => {
    if (remote || !tlsAvailable || busy || picking) return;
    setPicking(target);
    setTlsError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: target === 'cert' ? t('config.tls.selectCertTitle') : t('config.tls.selectKeyTitle'),
        filters: [{ name: target === 'cert' ? t('config.tls.certFile') : t('config.tls.keyFile'), extensions: target === 'cert' ? ['pem', 'crt', 'cer'] : ['pem', 'key'] }],
      });
      if (typeof selected === 'string') edit(target === 'cert' ? 'tlsCert' : 'tlsKey', selected);
    } catch (cause) {
      setTlsError(t('config.tls.error.selectFileFailed', { error: String(cause) }));
    } finally {
      setPicking(null);
    }
  };

  const save = async () => {
    if (busy) return;
    const host = draft.host.trim();
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError(t('config.error.portRange'));
      return;
    }
    const cert = draft.tlsCert.trim();
    const key = draft.tlsKey.trim();
    const tlsDirty = dirty.some((field) => field.startsWith('tls'));
    if (tlsDirty && draft.tlsEnabled && (!cert || !key)) {
      setTlsError(t('config.tls.error.pathsRequired'));
      return;
    }
    const networkDirty = dirty.some((field) => !field.startsWith('tls'));
    const endpointChanged = dirty.includes('host') || dirty.includes('port');
    const proxyChanged = dirty.includes('proxyUrl') || dirty.includes('proxyOverride');

    setBusy(true);
    setSaveError('');
    setPortError('');
    setTlsError('');
    setNotice(null);
    let needsRestart = false;
    let failure = '';
    if (networkDirty) {
      try {
        apply(await invoke<CoreConfigSettings>('save_network_endpoint_settings', {
          settings: proxyChanged
            ? { host, port, proxyUrl: draft.proxyUrl.trim(), proxyOverride: draft.proxyOverride }
            : { host, port },
        }));
        needsRestart ||= endpointChanged;
      } catch (cause) {
        failure = t('config.error.saveFailed', { error: String(cause) });
        void reload();
      }
    }
    if (!failure && tlsDirty) {
      try {
        const saved = await invoke<TlsSettings>('save_core_tls_settings', { settings: { enabled: draft.tlsEnabled, cert, key } });
        tlsRequests.invalidate();
        setTls(saved);
        needsRestart = true;
      } catch (cause) {
        failure = String(cause);
        void loadTls();
      }
    }
    if (needsRestart && status?.running && !remote) {
      try {
        publishStatus(await invoke<CoreStatus>('restart_core_process'));
        setNotice('restarted');
      } catch (cause) {
        failure ||= t('config.error.networkRestartFailed', { error: String(cause) });
        void refreshStatus();
      }
    } else if (needsRestart && remote) setNotice('remote');
    else if (needsRestart) setNotice('nextStart');
    else if (!failure) setNotice('applied');
    if (failure) {
      setNotice(null);
      setSaveError(failure);
    }
    setBusy(false);
  };

  const discard = () => {
    reset();
    setPortError('');
    setTlsError('');
    setSaveError('');
    setNotice(null);
  };

  const noticeText: Record<Notice, string> = {
    restarted: t('sec.settings.network.saved.restarted'),
    nextStart: t('sec.settings.network.saved.nextStart'),
    remote: t('connection.lifecycleHint'),
    applied: t('sec.settings.network.saved.applied'),
  };

  return (
    <div className="ec-net">
      <SettingsGroup title={t('sec.settings.network.listen.title')} icon={<Network size={16} />}>
        <SettingRow label={t('kernel.control.allowLan')} hint={t('sec.settings.network.listen.lanHint')} effect="restart" icon={<Wifi size={14} />}>
          <Toggle checked={lan} label={t('kernel.control.allowLanAria')} disabled={busy} onChange={(next) => edit('host', next ? '0.0.0.0' : '127.0.0.1')} />
        </SettingRow>
        <SettingRow label={t('config.network.listenHost')} hint={t('sec.settings.network.listen.hostHint')} effect="restart" htmlFor="ec-net-host">
          <input id="ec-net-host" className="ec-set-input is-mono" type="text" value={draft.host} disabled={busy} placeholder="127.0.0.1"
            onChange={(event) => edit('host', event.currentTarget.value)} />
        </SettingRow>
        <SettingRow label={t('config.network.port')} hint={t('config.network.portHint')} effect="restart" htmlFor="ec-net-port" error={portError}>
          <input id="ec-net-port" className="ec-set-input is-short" type="text" inputMode="numeric" maxLength={5} value={draft.port} disabled={busy}
            aria-invalid={Boolean(portError) || undefined}
            onChange={(event) => edit('port', event.currentTarget.value.replace(/\D/g, '').slice(0, 5))} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('sec.settings.network.proxy.title')} icon={<Globe size={16} />}>
        <SettingRow label={t('config.network.systemProxy')} hint={t('config.network.systemProxyHint')} effect="instant" icon={<Link2 size={14} />}>
          <Toggle checked={!draft.proxyOverride} label={t('config.network.systemProxy')} disabled={busy} onChange={(next) => edit('proxyOverride', !next)} />
        </SettingRow>
        <SettingRow label={t('config.network.proxyUrl')} hint={t('config.network.proxyHint')} effect="instant" htmlFor="ec-net-proxy">
          <input id="ec-net-proxy" className="ec-set-input is-mono" type="text" value={draft.proxyUrl} disabled={busy || !draft.proxyOverride}
            placeholder={t('config.network.proxyPlaceholder')} onChange={(event) => edit('proxyUrl', event.currentTarget.value)} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('sec.settings.network.tls.title')}
        icon={<LockKeyhole size={16} />}
        status={tlsLoading ? null : <Chip size="sm" tone={saved?.tlsEnabled ? 'ok' : 'neutral'}>{saved?.tlsEnabled ? t('sec.settings.network.tls.on') : t('sec.settings.network.tls.off')}</Chip>}
      >
        {tlsLoadError ? <p className="ec-net-note is-error" role="alert">{t('sec.settings.network.tls.loadFailed', { error: tlsLoadError })}</p> : null}
        <SettingRow label={t('config.tls.enable')} hint={`${t('config.tls.enableDescription')} ${t('config.tls.restartHint')}`} effect="restart" icon={<LockKeyhole size={14} />}>
          <Toggle checked={draft.tlsEnabled} label={t('config.tls.enable')} disabled={tlsControlsDisabled} onChange={(next) => edit('tlsEnabled', next)} />
        </SettingRow>
        {draft.tlsEnabled ? (
          <>
            {(['cert', 'key'] as const).map((target) => {
              const field = target === 'cert' ? 'tlsCert' : 'tlsKey';
              const label = target === 'cert' ? t('config.tls.cert') : t('config.tls.key');
              const missing = tlsError !== '' && !draft[field].trim();
              return (
                <SettingRow key={target} stacked label={label} hint={target === 'cert' ? t('config.tls.certHint') : t('config.tls.keyHint')} htmlFor={`ec-net-tls-${target}`}
                  error={missing ? tlsError : undefined}>
                  <span className="ec-net-path">
                    <input id={`ec-net-tls-${target}`} className="ec-set-input is-wide is-mono" type="text" value={draft[field]}
                      disabled={remote || tlsControlsDisabled} aria-invalid={missing || undefined}
                      placeholder={target === 'cert' ? t('config.tls.certPlaceholder') : t('config.tls.keyPlaceholder')}
                      onChange={(event) => edit(field, event.currentTarget.value)} />
                    <Button size="sm" variant="secondary" icon={<FolderOpen size={14} />} loading={picking === target}
                      disabled={remote || tlsControlsDisabled}
                      title={remote ? t('sec.settings.network.tls.remoteOnly') : target === 'cert' ? t('config.tls.selectCertTitle') : t('config.tls.selectKeyTitle')}
                      onClick={() => void pickFile(target)}>
                      {t('config.tls.browse')}
                    </Button>
                  </span>
                </SettingRow>
              );
            })}
            {remote ? <p className="ec-net-note">{t('sec.settings.network.tls.remoteOnly')}</p> : null}
            {tlsError && draft.tlsCert.trim() && draft.tlsKey.trim() ? <p className="ec-net-note is-error" role="alert">{tlsError}</p> : null}
          </>
        ) : null}
      </SettingsGroup>

      {notice && notice !== 'applied' && dirty.length === 0 ? <p className="ec-net-notice" role="status">{noticeText[notice]}</p> : null}
      <SaveBar count={dirty.length} busy={busy} onSave={() => void save()} onDiscard={discard} error={saveError} saved={notice !== null} />
    </div>
  );
}
