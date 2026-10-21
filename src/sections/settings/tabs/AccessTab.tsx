import { useState, type FormEvent } from 'react';
import { invoke } from '../../../services/documentTarget';
import { Eye, EyeOff, ExternalLink, KeyRound, Pencil, Plus, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useCoreRuntime } from '../../../coreRuntime';
import { webUiManagementUrl } from '../../../services/clientAccess';
import { getCoreConnection } from '../../../services/coreConnection';
import { allSettingsTemplateGroups } from '../../../services/settingsNavigation';
import { TemplateConfigSection } from '../../../components/TemplateConfigSection';
import { Button, Chip, ConfirmDialog, CopyButton, Dialog, EmptyState, ErrorState, IconButton, Masked, Skeleton } from '../../../ui';
import { useCoreConfig, type CoreApiKey, type CoreConfigSettings } from '../coreConfig';
import { SettingRow, SettingsGroup, useReportDirty } from '../ui';
import './AccessTab.css';

type TlsSettings = { enabled: boolean; cert: string; key: string };

/** 24 random bytes as hex, prefixed (same shape the old Config page generated). */
function randomSecret(prefix: string) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function AccessTab() {
  const { t } = useI18n();
  const { settings, loading, error, reload, apply } = useCoreConfig();
  const { status } = useCoreRuntime();
  const remote = status?.connectionMode === 'remote';
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [keyDialog, setKeyDialog] = useState<{ editing: CoreApiKey | null } | null>(null);
  const [deleting, setDeleting] = useState<CoreApiKey | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [dirtyTemplateGroups, setDirtyTemplateGroups] = useState<readonly string[]>([]);
  useReportDirty('access', dirtyTemplateGroups.length > 0);

  if (loading && !settings) return <div className="ec-set-skel" aria-busy="true"><Skeleton lines={5} /></div>;
  if (!settings) return <ErrorState title={t('sec.settings.loadFailed')} message={error} onRetry={() => void reload()} />;

  /** Runs one native command; returns an error string or null. Applies the returned settings on success. */
  const run = async (command: string, args: Record<string, unknown>): Promise<string | null> => {
    setBusy(true);
    setActionError('');
    try {
      apply(await invoke<CoreConfigSettings>(command, args));
      return null;
    } catch (cause) {
      const message = t('sec.settings.access.keys.saveFailed', { error: String(cause) });
      setActionError(message);
      void reload();
      return message;
    } finally {
      setBusy(false);
    }
  };

  const openWebUi = async () => {
    setActionError('');
    try {
      const connection = await getCoreConnection();
      if (connection.mode === 'remote') {
        await invoke('open_external_url', { url: `${connection.managementOrigin}/management.html#/login` });
        return;
      }
      // Resolve the current URL only when opening the management UI.
      const tls = await invoke<TlsSettings>('get_core_tls_settings');
      const latest = settings;
      await invoke('open_external_url', { url: webUiManagementUrl(latest.port, tls.enabled, latest.host) });
    } catch (cause) {
      setActionError(t('config.webuiKey.error.openFailed', { error: String(cause) }));
    }
  };

  const submitKey = async (apiKey: string, remark: string): Promise<string | null> => {
    const editing = keyDialog?.editing ?? null;
    const failure = await run(
      editing ? 'update_core_api_key' : 'add_core_api_key',
      editing ? { originalApiKey: editing.apiKey, apiKey, remark } : { apiKey, remark },
    );
    if (!failure) setKeyDialog(null);
    return failure;
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const failure = await run('delete_core_api_key', { apiKey: deleting.apiKey });
    if (!failure) setDeleting(null);
  };

  const submitSecret = async (secretKey: string): Promise<string | null> => {
    const failure = await run('set_core_management_secret_key', { secretKey });
    if (!failure) setSecretOpen(false);
    return failure;
  };

  const confirmClear = async () => {
    const failure = await run('clear_core_management_secret_key', {});
    if (!failure) setClearOpen(false);
  };

  const keys = settings.apiKeys;
  const configured = settings.managementSecretConfigured;

  return (
    <div className="ec-access">
      {actionError ? <p className="ec-access-error" role="alert">{actionError}</p> : null}

      <SettingsGroup
        title={t('sec.settings.access.keys.title')}
        icon={<KeyRound size={16} />}
        status={keys.length === 0
          ? <Chip size="sm" tone="warn">{t('sec.settings.access.keys.openAccess')}</Chip>
          : <Chip size="sm" tone="neutral">{keys.length}</Chip>}
        actions={<Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={busy} onClick={() => setKeyDialog({ editing: null })}>{t('config.keys.add')}</Button>}
      >
        {keys.length === 0 ? (
          <div className="ec-access-empty">
            <EmptyState compact icon={<KeyRound size={22} />} title={t('sec.settings.access.keys.emptyTitle')}
              action={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setKeyDialog({ editing: null })}>{t('config.keys.add')}</Button>} />
          </div>
        ) : (
          <ul className="ec-access-keys" aria-label={t('sec.settings.access.keys.title')}>
            {keys.map((entry, index) => (
              <li key={entry.apiKey} className="ec-access-key" data-testid="api-key-row">
                <Masked as="code" kind="identifier" mono value={entry.apiKey} className="ec-access-key-value" />
                <span className="ec-access-key-remark">
                  {entry.remark ? <Masked value={entry.remark} /> : <span className="ec-access-muted">{t('config.keys.noRemark')}</span>}
                </span>
                <span className="ec-access-key-actions">
                  <CopyButton value={entry.apiKey} size="sm" />
                  <IconButton size="sm" label={t('config.keys.editNth', { number: index + 1 })} icon={<Pencil size={14} />} disabled={busy} onClick={() => setKeyDialog({ editing: entry })} />
                  <IconButton size="sm" label={t('config.keys.deleteNth', { number: index + 1 })} icon={<Trash2 size={14} />} disabled={busy} onClick={() => setDeleting(entry)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('sec.settings.access.mgmt.title')}
        icon={<ShieldCheck size={16} />}
        status={<Chip size="sm" tone={configured ? 'ok' : 'warn'}>{configured ? t('sec.settings.access.mgmt.configured') : t('sec.settings.access.mgmt.notConfigured')}</Chip>}
      >
        <SettingRow label={t('sec.settings.access.mgmt.keyRow')} hint={t('sec.settings.access.mgmt.keyHint')} effect="instant" icon={<KeyRound size={14} />}>
          {configured ? null : <span className="ec-access-muted">{t('sec.settings.access.mgmt.disabledNote')}</span>}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setSecretOpen(true)}>
            {configured ? t('sec.settings.access.mgmt.change') : t('sec.settings.access.mgmt.set')}
          </Button>
          <Button size="sm" variant="danger" disabled={busy || !configured} onClick={() => setClearOpen(true)}>{t('sec.settings.access.mgmt.clear')}</Button>
        </SettingRow>
        <SettingRow label={t('sec.settings.access.mgmt.webRow')} icon={<ExternalLink size={14} />}>
          <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => void openWebUi()}
            title={remote ? status?.remoteOrigin || undefined : webUiManagementUrl(settings.port, undefined, settings.host)}>
            {t('config.webuiKey.open')}
          </Button>
        </SettingRow>
        <div className="ec-access-template">
          <TemplateConfigSection groups={allSettingsTemplateGroups} visibleGroups={['management']} onDirtyGroupsChange={setDirtyTemplateGroups} />
        </div>
      </SettingsGroup>

      <KeyDialog
        key={keyDialog?.editing?.apiKey ?? (keyDialog ? 'new' : 'closed')}
        open={keyDialog !== null}
        editing={keyDialog?.editing ?? null}
        existing={keys}
        busy={busy}
        onClose={() => setKeyDialog(null)}
        onSubmit={submitKey}
      />
      <SecretDialog key={secretOpen ? 'open' : 'closed'} open={secretOpen} busy={busy} onClose={() => setSecretOpen(false)} onSubmit={submitSecret} />
      <ConfirmDialog
        open={deleting !== null}
        danger
        busy={busy}
        title={t('config.keys.deleteTitle')}
        message={
          <>
            {deleting ? <Masked as="code" kind="identifier" mono value={deleting.apiKey} /> : null}
            <span className="ec-access-confirm-text">{t('sec.settings.access.keys.deleteMessage')}</span>
            {keys.length === 1 ? <Chip size="sm" tone="warn">{t('sec.settings.access.keys.deleteLastWarning')}</Chip> : null}
          </>
        }
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={clearOpen}
        danger
        busy={busy}
        title={t('sec.settings.access.mgmt.clear')}
        message={t('sec.settings.access.mgmt.disableMessage')}
        confirmLabel={t('sec.settings.access.mgmt.clear')}
        onCancel={() => setClearOpen(false)}
        onConfirm={() => void confirmClear()}
      />
    </div>
  );
}

/** Add / edit one client key. Same validation as the old ConfigPanel.submitApiKey. */
function KeyDialog({ open, editing, existing, busy, onClose, onSubmit }: {
  open: boolean; editing: CoreApiKey | null; existing: CoreApiKey[]; busy: boolean;
  onClose: () => void; onSubmit: (apiKey: string, remark: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState(editing?.apiKey ?? '');
  const [remark, setRemark] = useState(editing?.remark ?? '');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) return setError(t('config.error.emptyKey'));
    if (!/^[\x21-\x7e]+$/.test(key)) return setError(t('config.error.invalidKey'));
    if (existing.some((entry) => entry.apiKey === key && entry.apiKey !== editing?.apiKey)) return setError(t('config.error.duplicateKey'));
    const note = remark.trim();
    if (note.length > 80) return setError(t('config.error.remarkTooLong'));
    const failure = await onSubmit(key, note);
    if (failure) setError(failure);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={editing ? t('config.keys.editTitle') : t('config.keys.addTitle')}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="ec-access-key-form" loading={busy}>{editing ? t('common.save') : t('common.add')}</Button>
        </>
      }
    >
      <form id="ec-access-key-form" className="ec-access-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="ec-access-field">
          <span>{t('config.keys.label')}</span>
          <span className="ec-access-input-row">
            <input
              className="ec-access-input"
              type={show ? 'text' : 'password'}
              autoComplete="off"
              autoFocus
              value={apiKey}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => { setApiKey(event.currentTarget.value); setError(''); }}
            />
            <IconButton size="sm" label={show ? t('config.keys.hide') : t('config.keys.show')} icon={show ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShow((value) => !value)} />
          </span>
        </label>
        <Button size="sm" variant="outline" icon={<Sparkles size={14} />} className="ec-access-generate" onClick={() => { setApiKey(randomSecret('sk-')); setShow(true); setError(''); }}>
          {t('config.keys.generate')}
        </Button>
        <label className="ec-access-field">
          <span>{t('config.keys.remark')}</span>
          <input
            className="ec-access-input is-plain"
            type="text"
            maxLength={80}
            value={remark}
            placeholder={t('config.keys.remarkPlaceholder')}
            onChange={(event) => { setRemark(event.currentTarget.value); setError(''); }}
          />
        </label>
        {error ? <p className="ec-access-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

/** Set the management key: new + confirm, generator, same validation as the old saveManagementSecret. */
function SecretDialog({ open, busy, onClose, onSubmit }: {
  open: boolean; busy: boolean; onClose: () => void; onSubmit: (secretKey: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = secret.trim();
    if (!value) return setError(t('config.webuiKey.error.empty'));
    if (value.length > 512) return setError(t('config.webuiKey.error.tooLong'));
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return setError(t('config.webuiKey.error.invalid'));
    if (value !== confirm.trim()) return setError(t('config.webuiKey.error.mismatch'));
    const failure = await onSubmit(value);
    if (failure) setError(failure);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={t('sec.settings.access.mgmt.dialogTitle')}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="ec-access-secret-form" loading={busy} disabled={!secret.trim()}>{t('config.webuiKey.save')}</Button>
        </>
      }
    >
      <form id="ec-access-secret-form" className="ec-access-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="ec-access-field">
          <span>{t('config.webuiKey.newKey')}</span>
          <span className="ec-access-input-row">
            <input
              className="ec-access-input"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              maxLength={512}
              value={secret}
              placeholder={t('config.webuiKey.placeholder')}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => { setSecret(event.currentTarget.value); setError(''); }}
            />
            <IconButton size="sm" label={show ? t('config.keys.hide') : t('config.keys.show')} icon={show ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShow((value) => !value)} />
          </span>
        </label>
        <label className="ec-access-field">
          <span>{t('config.webuiKey.confirmKey')}</span>
          <input
            className="ec-access-input"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            maxLength={512}
            value={confirm}
            placeholder={t('config.webuiKey.confirmPlaceholder')}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => { setConfirm(event.currentTarget.value); setError(''); }}
          />
        </label>
        <Button size="sm" variant="outline" icon={<Sparkles size={14} />} className="ec-access-generate" onClick={() => { const value = randomSecret('webui-'); setSecret(value); setConfirm(value); setShow(true); setError(''); }}>
          {t('config.webuiKey.generate')}
        </Button>
        {error ? <p className="ec-access-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
