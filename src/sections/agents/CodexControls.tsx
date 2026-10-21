import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useCoreConnectionMode, useCoreRunning } from '../../coreRuntime';
import { AgentModelPicker } from '../../components/AgentModelPicker';
import { invoke } from '../../services/platform';
import type { CodexCatalogEditorSaveResult, CodexCatalogEditorSnapshot } from '../../services/codexModelCatalog';
import type { CodexSessionRepairResult } from '../../services/codexSessionState';
import { Button, Checkbox, Dialog, Toggle } from '../../ui';
import { InlineNotice } from './InlineNotice';
import { ManageRow } from './ManageRow';
import type { AgentsController } from './useAgentsController';

/** Codex rows of the Manage tab: openai provider identity (with optional session sync), remote compaction, approval model. Each writes through its own command and reloads the client status. */

const isDisabled = (ctl: AgentsController) => ctl.busy || ctl.loading || ctl.hasPendingChanges;

export function CodexProviderRow({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const status = ctl.activeStatus;
  // Session metadata lives on this computer's disk, so syncing it applies to Local only.
  const remote = useCoreConnectionMode() === 'remote';
  const enabled = Boolean(status?.codexOpenaiProvider);
  const [target, setTarget] = useState<boolean | null>(null);
  const [syncSessions, setSyncSessions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const apply = async () => {
    if (target === null || saving) return;
    const next = target;
    const provider = next ? 'openai' : 'cpa-gui';
    setSaving(true);
    ctl.setBusyAction('codex-provider');
    setNotice('');
    setError('');
    let switched = false;
    try {
      await invoke('set_codex_openai_provider', { enabled: next });
      switched = true;
      setNotice(t('agents.provider.switched', { provider }));
      if (syncSessions && !remote) {
        try {
          const result = await invoke<CodexSessionRepairResult>('repair_codex_session_metadata', { expectedProvider: provider });
          const summary = t('agents.sessions.repairResult', {
            provider: result.targetProvider, files: result.changedRolloutFiles,
            rows: result.sqliteRowsUpdated, skipped: result.skippedLockedFiles.length,
          });
          setNotice([
            t('agents.provider.switched', { provider }), summary,
            result.encryptedContentWarning, ...result.warnings,
            result.backupPath ? t('agents.sessions.backupAt', { path: result.backupPath }) : '',
          ].filter(Boolean).join(' '));
        } catch (cause) {
          setError(t('agents.provider.syncFailed', { error: String(cause) }));
        }
      }
    } catch (cause) {
      setError(String(cause).includes('CPA_CODEX_OAUTH_AUTH_UNSUPPORTED')
        ? t('agents.provider.oauthUnsupported') : String(cause));
    } finally {
      if (switched) {
        setTarget(null);
        try { await ctl.codexSettingChanged({ codexOpenaiProvider: next }); } catch (cause) {
          setError((previous) => [previous, t('agents.provider.refreshFailed', { error: String(cause) })].filter(Boolean).join(' '));
        }
      }
      setSaving(false);
      ctl.setBusyAction(null);
    }
  };

  const disabled = isDisabled(ctl) || (!status?.configured && !enabled);
  return (
    <>
      <ManageRow label={t('agents.provider.label')} hint={t('agents.provider.hint')} data-row="codex-provider"
        value={<>
          <InlineNotice tone="info" message={notice} />
          {target === null ? <InlineNotice tone="error" message={error} /> : null}
        </>}
        actions={<Toggle checked={enabled} label={t('agents.provider.label')} disabled={disabled || saving}
          onChange={(next) => { setTarget(next); setSyncSessions(false); setError(''); setNotice(''); }} />} />
      <Dialog open={target !== null} size="sm" busy={saving} onClose={() => setTarget(null)}
        title={t('agents.provider.title', { provider: target ? 'openai' : 'cpa-gui' })}
        footer={<>
          <Button variant="secondary" disabled={saving} onClick={() => setTarget(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void apply()}>{t('common.confirm')}</Button>
        </>}>
        <div className="ag-dlg">
          <p>{t('agents.provider.description')}</p>
          {remote ? <p className="ec-muted">{t('agents.provider.syncRemote')}</p> : <>
            <Checkbox checked={syncSessions} disabled={saving} label={t('agents.provider.sync')}
              onChange={(event) => setSyncSessions(event.currentTarget.checked)} />
            <p className="ec-muted">{t('agents.provider.syncHint')}</p>
          </>}
          <InlineNotice tone="error" message={error} />
        </div>
      </Dialog>
    </>
  );
}

export function CodexRemoteCompactionRow({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const status = ctl.activeStatus;
  const builtinProvider = Boolean(status?.codexOpenaiProvider);
  const enabled = Boolean(status?.codexRemoteCompaction);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const apply = async (next: boolean) => {
    if (saving || builtinProvider) return;
    setSaving(true);
    ctl.setBusyAction('remote-compaction');
    setError('');
    setSaved(false);
    try {
      await invoke('set_codex_remote_compaction', { enabled: next });
      setSaved(true);
      await ctl.codexSettingChanged({ codexRemoteCompaction: next });
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); ctl.setBusyAction(null); }
  };

  const disabled = isDisabled(ctl) || !status?.configured || ctl.nativeOauth || builtinProvider;
  return (
    <ManageRow label={t('agents.remoteCompaction.label')} data-row="codex-remote-compaction"
      hint={t(builtinProvider ? 'agents.remoteCompaction.builtinHint' : 'agents.remoteCompaction.hint')}
      value={<>
        <InlineNotice tone="error" message={error} />
        <InlineNotice tone="success" message={saved ? t('agents.remoteCompaction.saved') : ''} />
      </>}
      actions={<Toggle checked={enabled || builtinProvider} label={t('agents.remoteCompaction.label')} disabled={disabled || saving}
        onChange={(next) => void apply(next)} />} />
  );
}

export function CodexApprovalModelRow({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<CodexCatalogEditorSnapshot | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The catalog comes from the core, so a stopped core is a state, not a failure.
  const stopped = useCoreRunning() === false;
  const load = useCallback(async () => {
    if (stopped) { setLoading(false); setError(''); setNotice(''); return; }
    setLoading(true); setError(''); setNotice('');
    try {
      const next = await invoke<CodexCatalogEditorSnapshot>('get_codex_model_catalog_editor');
      setSnapshot(next); setValue(next.defaultAutoReviewModel ?? '');
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  }, [stopped]);
  useEffect(() => { void load(); }, [load]);

  const disabled = isDisabled(ctl) || ctl.nativeOauth || stopped;
  const save = async () => {
    if (!snapshot || disabled || saving || loading) return;
    setSaving(true); ctl.setBusyAction('approval-model'); setError(''); setNotice('');
    try {
      const result = await invoke<CodexCatalogEditorSaveResult>('save_codex_model_catalog_editor', {
        request: {
          revision: snapshot.revision,
          models: snapshot.models.map(({ slug, configuration }) => ({ slug, configuration })),
          review_model: { model: value || null },
        },
      });
      setSnapshot(result.snapshot);
      setValue(result.snapshot.defaultAutoReviewModel ?? '');
      if (result.synchronizationError) setError(result.synchronizationError);
      else setNotice(t('agents.catalog.saved'));
    } catch (cause) {
      setError(String(cause).includes('CODEX_MODEL_CATALOG_CHANGED') ? t('agents.catalog.changed') : String(cause));
    } finally { setSaving(false); ctl.setBusyAction(null); }
  };

  const models = snapshot?.models.map(({ slug }) => ({ name: slug })) ?? [];
  const missing = Boolean(snapshot && value && !models.some((model) => model.name === value));
  return (
    <ManageRow label={t('agents.approvalModel.label')} hint={t('agents.approvalModel.hint')} data-row="codex-approval-model"
      value={<div className="ag-mg-approval">
        <AgentModelPicker models={models} value={value} loading={loading}
          disabled={disabled || saving || loading || !snapshot} preserveValue
          emptyOption={t('agents.approvalModel.default')}
          onChange={(next) => { setValue(next); setNotice(''); }}
          onRefresh={() => void load()} />
        {missing ? <span className="ec-muted">{t('agents.approvalModel.missing')}</span> : null}
        {stopped ? <span className="ec-muted">{t('sec.overview.notRunningReason')}</span> : null}
        <InlineNotice tone="error" message={error} />
        <InlineNotice tone="success" message={notice} />
      </div>}
      actions={<Button size="sm" variant="secondary" loading={saving}
        disabled={disabled || saving || loading || !snapshot || value === (snapshot?.defaultAutoReviewModel ?? '')}
        onClick={() => void save()}>
        {t('agents.approvalModel.save')}
      </Button>} />
  );
}
