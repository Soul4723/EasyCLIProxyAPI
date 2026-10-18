import { useCallback, useEffect, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { ArrowRight, Check, Download, Eye, EyeOff, FileUp, Globe, Laptop, PlugZap, Server, ShieldAlert, TriangleAlert, XCircle } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useCoreRuntime } from '../../../coreRuntime';
import { routeHref } from '../../../shell/router';
import {
  EMPTY_CONNECTION, changedConnectionFields, classifyConnectionResult, exportCoreConnection, getCoreConnection, importCoreConnection,
  isValidOrigin, saveCoreConnection, testCoreConnection, type ConnectionFailure, type CoreConnection,
} from '../../../services/coreConnection';
import { Button, Card, Chip, ErrorState, IconButton, Masked, SegmentedControl, Skeleton, Toggle } from '../../../ui';
import { useCoreConfig } from '../coreConfig';
import { SaveBar, SettingRow, SettingsGroup, useReportDirty } from '../ui';
import './ConnectionTab.css';

type Test = { state: 'idle' } | { state: 'running' } | { state: 'ok'; version: string | null } | { state: 'fail'; failure: ConnectionFailure; https: boolean } | { state: 'error'; message: string };

const hostOf = (origin: string | null | undefined) => {
  try { return new URL(origin ?? '').host; } catch { return origin ?? ''; }
};

export function ConnectionTab() {
  const { t } = useI18n();
  const { status, refreshStatus } = useCoreRuntime();
  const { settings: coreSettings } = useCoreConfig();
  const [savedConn, setSavedConn] = useState<CoreConnection | null>(null);
  const [draft, setDraft] = useState<CoreConnection>(EMPTY_CONNECTION);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'save' | 'import' | 'export' | null>(null);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [reveal, setReveal] = useState({ management: false, client: false });
  const [touched, setTouched] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const value = await getCoreConnection();
      if (!alive.current) return;
      setSavedConn(value); setDraft(value); setLoadError('');
    } catch (cause) { if (alive.current) setLoadError(String(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const count = savedConn ? changedConnectionFields(draft, savedConn) : 0;
  useReportDirty('connection', count > 0);

  const remoteDraft = draft.mode === 'remote';
  const ownedLocalRunning = status?.connectionMode !== 'remote' && Boolean(status?.managed && status.running);
  const mgmtOriginError = remoteDraft && !isValidOrigin(draft.managementOrigin) ? t('sec.settings.connection.errOrigin') : '';
  const clientOriginError = remoteDraft && !isValidOrigin(draft.clientOrigin) ? t('sec.settings.connection.errOrigin') : '';
  const mgmtKeyError = remoteDraft && !draft.managementKey.trim() ? t('sec.settings.connection.errRequired') : '';
  const invalid = remoteDraft && Boolean(mgmtOriginError || clientOriginError || mgmtKeyError);
  const blockedByLocal = remoteDraft && savedConn?.mode !== 'remote' && ownedLocalRunning;

  const change = (patch: Partial<CoreConnection>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setTest({ state: 'idle' }); setSaveError(''); setJustSaved(false); setNotice('');
  };

  const runTest = async () => {
    setTouched(true);
    if (invalid && (mgmtOriginError || mgmtKeyError)) return;
    setTest({ state: 'running' });
    try {
      const result = await testCoreConnection(draft);
      if (!alive.current) return;
      const failure = classifyConnectionResult(result);
      setTest(failure ? { state: 'fail', failure, https: draft.managementOrigin.trim().startsWith('https:') } : { state: 'ok', version: result.version });
    } catch (cause) { if (alive.current) setTest({ state: 'error', message: String(cause) }); }
  };

  const doSave = async () => {
    setTouched(true);
    if (invalid || blockedByLocal || busy) return;
    setBusy('save'); setSaveError(''); setNotice('');
    try {
      const next = await saveCoreConnection(draft);
      if (!alive.current) return;
      setSavedConn(next); setDraft(next); setJustSaved(true); setTest({ state: 'idle' });
      void refreshStatus();
    } catch (cause) { if (alive.current) setSaveError(String(cause)); }
    finally { if (alive.current) setBusy(null); }
  };

  const transfer = async (action: 'import' | 'export') => {
    if (busy) return;
    setBusy(action); setSaveError(''); setNotice('');
    try {
      const options = { title: t(action === 'import' ? 'connection.import' : 'connection.export'), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const path = action === 'import'
        ? await open({ ...options, multiple: false, directory: false })
        : await save({ ...options, defaultPath: 'easycli-connection.json' });
      if (typeof path !== 'string' || !alive.current) return;
      if (action === 'import') {
        const imported = await importCoreConnection(path);
        if (alive.current) { setDraft(imported); setTest({ state: 'idle' }); setJustSaved(false); setNotice(t('sec.settings.connection.importedReview')); }
      } else {
        await exportCoreConnection(path, includeSecrets);
        if (alive.current) setNotice(t('connection.exported'));
      }
    } catch (cause) { if (alive.current) setSaveError(String(cause)); }
    finally { if (alive.current) setBusy(null); }
  };

  if (loadError) return <ErrorState title={t('sec.settings.connection.loadFailed')} message={loadError} onRetry={() => void load()} />;
  if (!savedConn) return <Card><Skeleton lines={5} /></Card>;

  const remoteActive = status?.connectionMode === 'remote';
  const running = Boolean(status?.running);
  const exportBlock = savedConn.mode !== 'remote' ? t('sec.settings.connection.exportNeedsRemote') : count > 0 ? t('sec.settings.connection.exportNeedsSave') : '';
  const hostPort = coreSettings ? `${coreSettings.host}:${coreSettings.port}` : '';

  return (
    <div className="ec-con">
      <SettingsGroup title={t('sec.settings.connection.mode')} icon={<PlugZap size={15} />}>
        <div className="ec-con-mode">
          <SegmentedControl<CoreConnection['mode']>
            ariaLabel={t('sec.settings.connection.mode')}
            value={draft.mode}
            onChange={(mode) => change({ mode })}
            options={[
              { value: 'local', label: t('sec.settings.connection.modeLocal'), icon: <Laptop size={14} /> },
              { value: 'remote', label: t('sec.settings.connection.modeRemote'), icon: <Globe size={14} /> },
            ]}
          />
          {draft.mode !== savedConn.mode ? <Chip tone="warn" size="sm">{t('sec.settings.unsavedDot')}</Chip> : null}
        </div>
        <div className="ec-con-active" data-testid="connection-active" data-mode={remoteActive ? 'remote' : 'local'}>
          <span className="ec-con-active-title">{t('sec.settings.connection.active')}</span>
          <Chip tone={running ? 'ok' : 'warn'} size="sm" icon={running ? <Check size={12} /> : <XCircle size={12} />}>
            {running ? t('connection.connected') : (remoteActive ? t('connection.disconnected') : t('sec.settings.connection.notRunning'))}
          </Chip>
          <dl className="ec-con-facts">
            <div><dt>{t('sec.settings.connection.target')}</dt><dd>{remoteActive ? <Masked value={hostOf(status?.remoteOrigin)} kind="identifier" mono /> : <span className="ec-mono">{hostPort || '—'}</span>}</dd></div>
            <div><dt>{t('sec.settings.connection.version')}</dt><dd className="ec-mono">{status?.currentVersion ?? t('sec.settings.connection.unknownVersion')}</dd></div>
            {!remoteActive ? <div><dt>{t('sec.settings.connection.process')}</dt><dd>{status?.running ? (status.managed ? t('sec.settings.connection.managed') : t('sec.settings.connection.external')) : t('sec.settings.connection.notRunning')}{status?.processId ? <span className="ec-mono ec-muted"> · PID {status.processId}</span> : null}</dd></div> : null}
          </dl>
        </div>
      </SettingsGroup>

      {!remoteDraft ? (
        <SettingsGroup title={t('sec.settings.connection.modeLocal')} icon={<Server size={15} />}>
          <SettingRow label={t('sec.settings.connection.listens')}>
            <span className="ec-mono">{hostPort || '—'}</span>
            <a className="ec-con-link" href={routeHref('settings', 'network')}>{t('sec.settings.connection.networkLink')} <ArrowRight size={12} aria-hidden="true" /></a>
          </SettingRow>
          <SettingRow label={t('sec.settings.connection.process')}>
            <a className="ec-con-link" href={routeHref('overview')}>{t('sec.settings.connection.runtimeLink')} <ArrowRight size={12} aria-hidden="true" /></a>
          </SettingRow>
        </SettingsGroup>
      ) : (
        <>
          {blockedByLocal ? (
            <div className="ec-con-banner" role="status"><TriangleAlert size={14} aria-hidden="true" />{t('sec.settings.connection.stopLocalFirst')}<a className="ec-con-link" href={routeHref('overview')}>{t('sec.settings.connection.runtimeLink')} <ArrowRight size={12} aria-hidden="true" /></a></div>
          ) : null}
          <SettingsGroup title={t('sec.settings.connection.mgmtGroup')} icon={<Server size={15} />} id="connection-management">
            <SettingRow label={t('sec.settings.connection.mgmtOrigin')} htmlFor="con-mgmt-origin" stacked error={touched ? mgmtOriginError : ''}>
              <input id="con-mgmt-origin" className="ec-set-input is-wide is-mono" type="url" spellCheck={false} autoComplete="off" placeholder={t('connection.originPlaceholder')}
                value={draft.managementOrigin} aria-invalid={touched && Boolean(mgmtOriginError)} onChange={(e) => change({ managementOrigin: e.target.value })} />
            </SettingRow>
            <SettingRow label={t('sec.settings.connection.mgmtKey')} htmlFor="con-mgmt-key" stacked error={touched ? mgmtKeyError : ''}>
              <KeyInput id="con-mgmt-key" value={draft.managementKey} shown={reveal.management} invalid={touched && Boolean(mgmtKeyError)}
                onShow={(shown) => setReveal((r) => ({ ...r, management: shown }))} onChange={(managementKey) => change({ managementKey })} />
            </SettingRow>
          </SettingsGroup>
          <SettingsGroup title={t('sec.settings.connection.clientGroup')} icon={<Globe size={15} />} id="connection-client"
            actions={<Button size="sm" variant="ghost" onClick={() => change({ clientOrigin: draft.managementOrigin })}>{t('sec.settings.connection.sameOrigin')}</Button>}>
            <SettingRow label={t('sec.settings.connection.clientOrigin')} htmlFor="con-client-origin" stacked error={touched ? clientOriginError : ''}>
              <input id="con-client-origin" className="ec-set-input is-wide is-mono" type="url" spellCheck={false} autoComplete="off" placeholder={t('connection.originPlaceholder')}
                value={draft.clientOrigin} aria-invalid={touched && Boolean(clientOriginError)} onChange={(e) => change({ clientOrigin: e.target.value })} />
            </SettingRow>
            <SettingRow label={t('sec.settings.connection.clientKey')} htmlFor="con-client-key" stacked>
              <KeyInput id="con-client-key" value={draft.clientKey} shown={reveal.client} placeholder={t('sec.settings.connection.clientKeyOptional')}
                onShow={(shown) => setReveal((r) => ({ ...r, client: shown }))} onChange={(clientKey) => change({ clientKey })} />
            </SettingRow>
          </SettingsGroup>

          <Card className="ec-con-test" data-testid="connection-test" data-state={test.state}>
            <div className="ec-con-test-row">
              <Button variant="secondary" icon={<PlugZap size={14} />} loading={test.state === 'running'} onClick={() => void runTest()}>{test.state === 'running' ? t('sec.settings.connection.testing') : t('sec.settings.connection.test')}</Button>
              <span className="ec-muted ec-con-test-hint">{t('sec.settings.connection.testHint')}</span>
            </div>
            <TestResult test={test} />
          </Card>
        </>
      )}

      <SettingsGroup title={t('sec.settings.connection.portable')} icon={<Download size={15} />}>
        <SettingRow label={t('sec.settings.connection.withSecrets')}>
          {includeSecrets ? <Chip tone="warn" size="sm" icon={<ShieldAlert size={12} />}>{t('sec.settings.connection.secretsWarn')}</Chip> : null}
          <Toggle checked={includeSecrets} onChange={setIncludeSecrets} label={t('sec.settings.connection.withSecrets')} />
        </SettingRow>
        <div className="ec-con-portable">
          <Button variant="secondary" icon={<FileUp size={14} />} disabled={Boolean(busy)} loading={busy === 'import'} onClick={() => void transfer('import')}>{t('connection.import')}</Button>
          <span title={exportBlock || undefined}>
            <Button variant="secondary" icon={<Download size={14} />} disabled={Boolean(busy) || Boolean(exportBlock)} loading={busy === 'export'} onClick={() => void transfer('export')}>{t('connection.export')}</Button>
          </span>
          {exportBlock ? <span className="ec-muted ec-con-test-hint">{exportBlock}</span> : null}
        </div>
        {notice ? <p className="ec-con-notice" role="status">{notice}</p> : null}
      </SettingsGroup>

      <SaveBar count={count} saved={justSaved} busy={busy === 'save'} error={saveError} disabled={invalid || blockedByLocal}
        saveLabel={t(remoteDraft ? 'sec.settings.connection.saveConnect' : 'sec.settings.connection.saveLocal')}
        onSave={() => void doSave()} onDiscard={() => { setDraft(savedConn); setTest({ state: 'idle' }); setSaveError(''); setNotice(''); setTouched(false); }} />
    </div>
  );
}

function KeyInput({ id, value, shown, invalid, placeholder, onShow, onChange }: {
  id: string; value: string; shown: boolean; invalid?: boolean; placeholder?: string; onShow: (shown: boolean) => void; onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ec-con-key">
      <input id={id} className="ec-set-input is-wide is-mono" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={placeholder}
        value={value} aria-invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      <IconButton label={t(shown ? 'sec.settings.connection.hideKey' : 'sec.settings.connection.showKey')} icon={shown ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => onShow(!shown)} />
    </div>
  );
}

function TestResult({ test }: { test: Test }) {
  const { t } = useI18n();
  if (test.state === 'idle' || test.state === 'running') return null;
  if (test.state === 'ok') {
    return <div className="ec-con-result is-ok" role="status"><Check size={16} aria-hidden="true" /><strong>{test.version ? t('sec.settings.connection.testOkVersion', { version: test.version }) : t('sec.settings.connection.testOk')}</strong></div>;
  }
  if (test.state === 'error') {
    return <div className="ec-con-result is-fail" role="alert"><XCircle size={16} aria-hidden="true" /><strong>{t('connection.failed')}</strong><span>{test.message}</span></div>;
  }
  const { failure } = test;
  const title = failure.kind === 'http'
    ? t('sec.settings.connection.err.http', { status: failure.status ?? 0 })
    : t(`sec.settings.connection.err.${failure.kind}` as 'sec.settings.connection.err.unreachable');
  const hint = failure.kind === 'unreachable'
    ? t(test.https ? 'sec.settings.connection.err.tlsHint' : 'sec.settings.connection.err.unreachableHint')
    : failure.kind === 'invalid' ? '' : t(`sec.settings.connection.err.${failure.kind}Hint` as 'sec.settings.connection.err.authHint');
  return (
    <div className="ec-con-result is-fail" role="alert" data-failure={failure.kind}>
      <XCircle size={16} aria-hidden="true" /><strong>{title}</strong>{hint ? <span>{hint}</span> : null}
    </div>
  );
}
