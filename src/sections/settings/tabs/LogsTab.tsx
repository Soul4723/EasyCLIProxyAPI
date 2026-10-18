import { useCallback, useMemo, useState } from 'react';
import { invoke } from '../../../services/documentTarget';
import { BarChart3, FolderOpen, ScrollText } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useCoreRuntime, type CoreStatus } from '../../../coreRuntime';
import { TemplateConfigSection } from '../../../components/TemplateConfigSection';
import { allSettingsTemplateGroups, settingsTemplateGroups } from '../../../services/settingsNavigation';
import { Button, Chip, ErrorState, Skeleton, Toggle } from '../../../ui';
import { useCoreConfig, type CoreConfigSettings } from '../coreConfig';
import { SaveBar, SettingRow, SettingsGroup, useDraft, useReportDirty } from '../ui';
import './LogsTab.css';

type LoggingDraft = {
  debug: boolean;
  commercialMode: boolean;
  loggingToFile: boolean;
  logsMaxTotalSizeMb: string;
  errorLogsMaxFiles: string;
  usageStatisticsEnabled: boolean;
  redisUsageQueueRetentionSeconds: string;
};

const toDraft = (settings: CoreConfigSettings): LoggingDraft => ({
  debug: settings.debug,
  commercialMode: settings.commercialMode,
  loggingToFile: settings.loggingToFile,
  logsMaxTotalSizeMb: String(settings.logsMaxTotalSizeMb),
  errorLogsMaxFiles: String(settings.errorLogsMaxFiles),
  usageStatisticsEnabled: settings.usageStatisticsEnabled,
  redisUsageQueueRetentionSeconds: String(settings.redisUsageQueueRetentionSeconds),
});
const diagnosticsGroupIds = settingsTemplateGroups.diagnostics.map((group) => group.id);

export function LogsTab() {
  const { t } = useI18n();
  const { status, publishStatus, refreshStatus } = useCoreRuntime();
  const remote = status?.connectionMode === 'remote';
  const { settings, loading, error, reload, apply } = useCoreConfig();
  const saved = useMemo(() => (settings ? toDraft(settings) : null), [settings]);
  const { draft, setDraft, reset } = useDraft<LoggingDraft>(saved);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const [openingLogs, setOpeningLogs] = useState(false);
  const [openError, setOpenError] = useState('');
  const [templateDirty, setTemplateDirty] = useState<readonly string[]>([]);
  const onTemplateDirty = useCallback((ids: readonly string[]) => setTemplateDirty(ids.filter((id) => diagnosticsGroupIds.includes(id))), []);

  const count = draft && saved ? (Object.keys(saved) as (keyof LoggingDraft)[]).filter((key) => draft[key] !== saved[key]).length : 0;
  useReportDirty('logs', count > 0 || templateDirty.length > 0);

  const edit = (patch: Partial<LoggingDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setJustSaved(false); setRestarted(false); setSaveError('');
  };

  if (error && !settings) return <ErrorState title={t('sec.settings.logs.loadFailed')} message={error} onRetry={() => void reload()} />;
  if (loading && !settings || !settings || !draft) return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={5} /></div>;

  const restartsCore = draft.commercialMode !== settings.commercialMode && Boolean(status?.running) && !remote;

  const save = async () => {
    if (busy) return;
    const logsMaxTotalSizeMb = Number(draft.logsMaxTotalSizeMb);
    const errorLogsMaxFiles = Number(draft.errorLogsMaxFiles);
    const redisUsageQueueRetentionSeconds = Number(draft.redisUsageQueueRetentionSeconds);
    if (!Number.isInteger(logsMaxTotalSizeMb) || logsMaxTotalSizeMb < 0 || logsMaxTotalSizeMb > 4294967295
      || !Number.isInteger(errorLogsMaxFiles) || errorLogsMaxFiles < 0 || errorLogsMaxFiles > 4294967295) {
      setSaveError(t('sec.settings.logs.integerError'));
      return;
    }
    if (!Number.isInteger(redisUsageQueueRetentionSeconds) || redisUsageQueueRetentionSeconds < 1 || redisUsageQueueRetentionSeconds > 3600) {
      setSaveError(t('sec.settings.logs.retentionError'));
      return;
    }
    setBusy(true); setSaveError('');
    try {
      apply(await invoke<CoreConfigSettings>('save_core_logging_settings', {
        settings: {
          debug: draft.debug,
          commercialMode: draft.commercialMode,
          loggingToFile: draft.loggingToFile,
          logsMaxTotalSizeMb,
          errorLogsMaxFiles,
          usageStatisticsEnabled: draft.usageStatisticsEnabled,
          redisUsageQueueRetentionSeconds,
        },
      }));
      if (restartsCore) {
        publishStatus(await invoke<CoreStatus>('restart_core_process'));
        setRestarted(true);
      }
      setJustSaved(true);
    } catch (cause) {
      setSaveError(t('config.error.saveFailed', { error: String(cause) }));
      void refreshStatus();
      void reload();
    } finally { setBusy(false); }
  };

  const openLogs = async () => {
    if (openingLogs || remote) return;
    setOpeningLogs(true); setOpenError('');
    try { await invoke<void>('open_core_logs_directory'); }
    catch (cause) { setOpenError(t('sec.settings.logs.openFolderFailed', { error: String(cause) })); }
    finally { setOpeningLogs(false); }
  };

  const toggleRow = (key: 'debug' | 'commercialMode' | 'loggingToFile' | 'usageStatisticsEnabled', label: string, hint: string, effect?: 'restart' | 'remote-host') => (
    <SettingRow label={label} hint={hint} effect={effect}>
      <Toggle checked={draft[key]} label={label} disabled={busy} onChange={(next) => edit({ [key]: next })} />
    </SettingRow>
  );
  const numberRow = (key: 'logsMaxTotalSizeMb' | 'errorLogsMaxFiles' | 'redisUsageQueueRetentionSeconds', label: string, hint: string, min: number, max?: number) => (
    <SettingRow label={label} hint={hint} htmlFor={`logs-${key}`}>
      <input
        id={`logs-${key}`}
        className="ec-set-input is-short"
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => edit({ [key]: event.currentTarget.value })}
      />
    </SettingRow>
  );

  return (
    <div className="ec-logs">
      <SettingsGroup
        title={t('sec.settings.logs.groupLogging')}
        icon={<ScrollText size={16} />}
        status={restarted ? <Chip size="sm" tone="ok">{t('sec.settings.logs.savedRestarted')}</Chip> : undefined}
      >
        {toggleRow('debug', t('config.diagnostics.debug.title'), t('config.diagnostics.debug.description'))}
        {toggleRow('commercialMode', t('config.diagnostics.commercial.title'),
          `${t('config.diagnostics.commercial.description')} ${t('config.diagnostics.commercial.warning')}`, remote ? 'remote-host' : 'restart')}
        {toggleRow('loggingToFile', t('config.diagnostics.fileLogging.title'), t('config.diagnostics.fileLogging.description'))}
        {numberRow('logsMaxTotalSizeMb', t('config.diagnostics.maxSize.title'), t('config.diagnostics.maxSize.hint'), 0)}
        {numberRow('errorLogsMaxFiles', t('config.diagnostics.errorFiles.title'), t('config.diagnostics.errorFiles.hint'), 0)}
        <SettingRow label={t('config.diagnostics.openLogs')} hint={t('sec.settings.logs.openFolderHint')} icon={<FolderOpen size={14} />} error={openError || undefined}>
          {remote ? <span className="ec-logs-reason">{t('sec.settings.logs.remoteOnly')}</span> : null}
          <Button size="sm" icon={<FolderOpen size={14} />} loading={openingLogs} disabled={remote} title={remote ? t('sec.settings.logs.remoteOnly') : undefined} onClick={() => void openLogs()}>
            {t('config.diagnostics.openLogs')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('sec.settings.logs.groupUsage')} icon={<BarChart3 size={16} />}>
        {toggleRow('usageStatisticsEnabled', t('config.diagnostics.usage.title'), t('config.diagnostics.usage.description'))}
        {numberRow('redisUsageQueueRetentionSeconds', t('config.diagnostics.redisRetention.title'), t('config.diagnostics.redisRetention.hint'), 1, 3600)}
      </SettingsGroup>

      {restartsCore && count > 0 ? <p className="ec-logs-note" role="status">{t('sec.settings.logs.restartNote')}</p> : null}

      <SaveBar
        count={count}
        busy={busy}
        error={saveError}
        saved={justSaved}
        onSave={() => void save()}
        onDiscard={() => { reset(); setSaveError(''); setJustSaved(false); }}
      />

      <div className="ec-logs-more">
        <TemplateConfigSection groups={allSettingsTemplateGroups} visibleGroups={diagnosticsGroupIds} onDirtyGroupsChange={onTemplateDirty} />
      </div>
    </div>
  );
}
