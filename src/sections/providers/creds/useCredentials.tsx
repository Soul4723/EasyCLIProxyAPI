import { credentialsSource } from '../../../services/credentials';
import { useDataSource } from '../../../services/dataSource';
/**
 * useCredentials(): state + actions for the OAuth credential files of the Providers section.
 *
 * Reuses src/services unchanged (managementApi, authFiles, authFileHealth). Render `controller.dialogs` once: it holds
 * the hidden import input, the confirm dialogs, the credential side panel and the toast. Quota refresh is NOT part of
 * this list (the Quota section owns it).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useCoreRuntime, useCoreTargetRevision } from '../../../coreRuntime';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { IconButton, useNow } from '../../../ui';
import { ConfirmDialog } from '../../../ui/Dialog';
import { X } from 'lucide-react';
import {
  authFileCooldownResetIndex,
  resetAuthFileCooldown,
  setOAuthCredentialFileDisabled,
} from '../../../services/authFiles';
import { managementApi } from '../../../services/managementApi';
import { CredentialPanel } from './CredentialPanel';
import {
  buildCredentialRows,
  summarizeByBrand,
  type AuthFile,
  type BrandSummary,
  type CredentialRow,
} from './model';
import './creds.css';

export type PanelSection = 'routing' | 'models' | 'cooldown' | 'advanced';
export type NoticeTone = 'success' | 'error';

export type CredentialsCore = {
  loading: boolean;
  /** Load failure text; action failures are shown as toasts instead. */
  error: string;
  busy: boolean;
  rows: CredentialRow[];
  summaryByBrand: Map<string, BrandSummary>;
  reload(): Promise<void>;
  /** Quiet refresh after an edit: keeps the list on screen. */
  refresh(): Promise<void>;
  /** Opens the file picker; uploads every chosen JSON file. */
  openImport(): void;
  openFolder(): Promise<void>;
  /** Set (non-empty) when opening the credential folder is impossible, e.g. remote core. */
  openFolderDisabledReason?: string;
  remote: boolean;
  select(name: string | null, section?: PanelSection): void;
  selectedName: string | null;
  /** Deep link: selects the credential whose file name or auth index equals `ref`; false when none matches (yet). */
  selectByRef(ref: string): boolean;
  selectedSection: PanelSection | null;
  toggle(row: CredentialRow): Promise<void>;
  /** Asks for confirmation, then deletes. */
  remove(row: CredentialRow): void;
  /** Asks for confirmation, then clears the routing cooldown (POST /routing/cooldown/reset). */
  clearCooldown(row: CredentialRow): void;
  copyName(row: CredentialRow): Promise<void>;
  /** Auth indexes whose cooldown reset is in flight. */
  cooldownBusy: ReadonlySet<string>;
  notify(text: string, tone?: NoticeTone): void;
  /** When the cooldown snapshot of the current list arrived. */
  receivedAtMs: number;
};

export type CredentialsController = CredentialsCore & { dialogs: ReactNode };

type Confirm = { kind: 'delete' | 'cooldown'; row: CredentialRow };
type Notice = { id: number; tone: NoticeTone; text: string };

export type UseCredentialsOptions = {
  /** Wires the panel's "Sign in again" button (shown for expired/error credentials) to the sign-in flow. */
  onReSignIn?: (provider: string) => void;
};

export function useCredentials({ onReSignIn }: UseCredentialsOptions = {}): CredentialsController {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const { status: coreStatus } = useCoreRuntime();
  const remote = coreStatus?.connectionMode === 'remote';
  const connectionRevision = useCoreTargetRevision();
  const connectionRevisionRef = useRef(connectionRevision);
  connectionRevisionRef.current = connectionRevision;
  const now = useNow(10_000);

  const source = useDataSource(credentialsSource);
  const snapshot = source.data ?? { files: [], receivedAtMs: 0 };
  const loading = source.loading;
  const error = source.error ?? '';
  const setSnapshot = credentialsSource.mutate;
  const [busy, setBusy] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<PanelSection | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [cooldownBusy, setCooldownBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const pendingCooldownRef = useRef(new Set<string>());
  const noticeId = useRef(0);

  const notify = useCallback((text: string, tone: NoticeTone = 'success') => {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, tone, text });
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice((current) => (current?.id === notice.id ? null : current)), notice.tone === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const load = useCallback((_showLoading: boolean) => credentialsSource.refresh(), []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const reload = credentialsSource.refresh;
  const refresh = credentialsSource.refresh;

  const rows = useMemo(() => buildCredentialRows(snapshot, now), [snapshot, now]);
  const summaryByBrand = useMemo(() => summarizeByBrand(rows), [rows]);

  const shownName = useCallback((row: CredentialRow) => mask.text(row.name, row.identities), [mask]);
  const failure = useCallback((reason: unknown) => notify(reason instanceof Error ? reason.message : String(reason), 'error'), [notify]);

  const select = useCallback((name: string | null, section?: PanelSection) => {
    setSelectedName(name);
    setSelectedSection(name ? section ?? null : null);
  }, []);

  const selectByRef = useCallback((ref: string) => {
    const wanted = ref.trim();
    if (!wanted) return false;
    const match = rows.find((row) => row.name === wanted) ?? rows.find((row) => row.authIndex === wanted);
    if (!match) return false;
    select(match.name);
    return true;
  }, [rows, select]);

  const openImport = useCallback(() => fileInputRef.current?.click(), []);

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (selected.length === 0) return;
    const initiatingRevision = connectionRevision;
    const isCurrentTarget = () => mountedRef.current && connectionRevisionRef.current === initiatingRevision;
    setBusy(true);
    let expectedRevision: number;
    try {
      expectedRevision = await managementApi.getTargetRevision();
      if (!isCurrentTarget()) return;
    } catch (requestError) {
      if (isCurrentTarget()) { failure(requestError); setBusy(false); }
      return;
    }
    let uploaded = 0;
    const failures: string[] = [];
    for (const file of selected) {
      try {
        await managementApi.uploadAuthFile(file, isCurrentTarget, expectedRevision);
        if (!isCurrentTarget()) return;
        uploaded += 1;
      } catch (requestError) {
        if (!isCurrentTarget()) return;
        failures.push(`${file.name}: ${String(requestError)}`);
      }
    }
    try {
      await load(false);
      // One toast: partial success must not hide the failures (or the other way round).
      const parts = [
        ...(uploaded > 0 ? [t('authFiles.uploaded', { count: uploaded })] : []),
        ...(failures.length > 0 ? [t('authFiles.uploadFailed', { count: failures.length, errors: failures.join('; ') })] : []),
      ];
      if (parts.length > 0) notify(parts.join(' · '), failures.length > 0 ? 'error' : 'success');
    } finally {
      setBusy(false);
    }
  };

  const openFolderDisabledReason = remote ? t('sec.providers.creds.openFolder.remote') : undefined;
  const openFolder = useCallback(async () => {
    if (remote) return;
    setBusy(true);
    try {
      await managementApi.openAuthFilesDirectory();
    } catch (requestError) {
      failure(requestError);
    } finally {
      setBusy(false);
    }
  }, [failure, remote]);

  const toggle = useCallback(async (row: CredentialRow) => {
    if (!row.editable) return;
    const disabled = !row.disabled;
    setBusy(true);
    // Optimistic: flip the row now, reload settles the truth.
    setSnapshot((current) => ({
      ...current!,
      files: (current?.files ?? []).map((file) => (file === row.file ? { ...file, disabled, status: disabled ? 'disabled' : 'active' } : file)),
    }));
    try {
      await setOAuthCredentialFileDisabled(row.file, disabled);
    } catch (requestError) {
      failure(requestError);
    } finally {
      await load(false);
      setBusy(false);
    }
  }, [failure, load]);

  const remove = useCallback((row: CredentialRow) => {
    if (row.runtimeOnly) {
      notify(t('authFiles.runtimeDeleteError'), 'error');
      return;
    }
    setConfirm({ kind: 'delete', row });
  }, [notify, t]);

  const clearCooldown = useCallback((row: CredentialRow) => {
    const index = authFileCooldownResetIndex(row.file);
    if (!index || pendingCooldownRef.current.has(index)) return;
    setConfirm({ kind: 'cooldown', row });
  }, []);

  const copyName = useCallback(async (row: CredentialRow) => {
    try {
      await navigator.clipboard.writeText(row.name);
      notify(t('sec.providers.creds.copied'));
    } catch {
      notify(t('common.copyFailed'), 'error');
    }
  }, [notify, t]);

  const runConfirmed = async () => {
    if (!confirm) return;
    const { kind, row } = confirm;
    setConfirmBusy(true);
    try {
      if (kind === 'delete') {
        await managementApi.delete('/credentials', { query: { name: row.name } });
        if (selectedName === row.name) select(null);
        setConfirm(null);
        notify(t('authFiles.deleted'));
        await load(false);
      } else {
        const index = authFileCooldownResetIndex(row.file);
        if (!index) return;
        pendingCooldownRef.current.add(index);
        setCooldownBusy((current) => new Set(current).add(index));
        setConfirm(null);
        try {
          await resetAuthFileCooldown(index);
          if (!mountedRef.current) return;
          // Drop list requests started before the reset and clear this credential's records at once.
          setSnapshot((current) => ({
            ...current!,
            files: (current?.files ?? []).map((file) => (authFileCooldownResetIndex(file) === index ? { ...file, cooldowns: [] } : file)),
          }));
          notify(t('authFiles.cooldown.resetSuccess', { name: shownName(row) }));
          await load(false);
        } finally {
          pendingCooldownRef.current.delete(index);
          if (mountedRef.current) setCooldownBusy((current) => { const next = new Set(current); next.delete(index); return next; });
        }
      }
    } catch (requestError) {
      setConfirm(null);
      notify(kind === 'cooldown'
        ? t('authFiles.cooldown.resetFailed', { name: shownName(row), message: requestError instanceof Error ? requestError.message : String(requestError) })
        : (requestError instanceof Error ? requestError.message : String(requestError)), 'error');
    } finally {
      setConfirmBusy(false);
    }
  };

  const core: CredentialsCore = {
    loading, error, busy, rows, summaryByBrand, reload, refresh, openImport, openFolder, openFolderDisabledReason, remote,
    select, selectedName, selectByRef, selectedSection, toggle, remove, clearCooldown, copyName, cooldownBusy, notify,
    receivedAtMs: snapshot.receivedAtMs,
  };

  const confirmRow = confirm?.row;
  const dialogs = (
    <>
      <input ref={fileInputRef} type="file" accept=".json,application/json" multiple hidden
        data-testid="creds-import-input" onChange={(event) => void handleUpload(event)} />
      <CredentialPanel controller={core} suspended={confirm !== null} onReSignIn={onReSignIn} />
      <ConfirmDialog
        open={confirm !== null}
        danger={confirm?.kind === 'delete'}
        busy={confirmBusy}
        title={confirm?.kind === 'cooldown' ? t('authFiles.cooldown.resetTitle') : t('common.delete')}
        message={confirmRow
          ? confirm?.kind === 'cooldown'
            ? t('authFiles.cooldown.resetConfirm', { name: shownName(confirmRow) })
            : t('authFiles.deleteConfirm', { name: shownName(confirmRow) })
          : undefined}
        confirmLabel={confirm?.kind === 'cooldown' ? t('authFiles.cooldown.resetButton') : t('common.delete')}
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(null)}
      />
      {notice ? (
        <div className={`ec-cred-toast ec-cred-toast--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} key={notice.id}>
          <span className="ec-cred-toast__text">{mask.text(notice.text)}</span>
          <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={() => setNotice(null)} />
        </div>
      ) : null}
    </>
  );

  return { ...core, dialogs };
}

export type { AuthFile };
