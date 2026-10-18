import { credentialsSource } from '../../services/credentials';
import { useDataSource } from '../../services/dataSource';
import { refreshQuotaBatch } from '../../services/quotaBatch';
// Data + actions for the quota page. Wraps the real services: /credentials (management API), quotaService
// (provider quota via the core request proxy), quotaCache, reset-credit actions, credential enable/disable and
// cooldown clear. No new backend behaviour.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ConfirmationOptions } from '../../components/ConfirmationDialog';
import { useQuotaReset } from '../../components/useQuotaReset';
import { authFileHealth } from '../../services/authFileHealth';
import {
  authFileCooldownResetIndex, resetAuthFileCooldown, setOAuthCredentialFileDisabled,
} from '../../services/authFiles';
import { readBoolean, readString } from '../../services/managementApi';
import {
  pruneQuotaCache, useQuotaCache,
} from '../../services/quotaCache';
import {
  idleQuota, providerForFile, quotaKey, type AuthFile, type QuotaState,
} from '../../services/quotaService';
import { useNow } from '../../ui';
import { buildAccount, sortAccounts, type QuotaAccount } from './model';

const NOW_TICK_MS = 30_000;

type FileSnapshot = { files: AuthFile[]; receivedAtMs: number; observedAt?: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type QuotaDataOptions = {
  askConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  /** Called whenever a successful quota snapshot is committed for an account (fetch, reset, other pages). */
  onFetched?: (account: QuotaAccount, quota: QuotaState) => void;
};

export function useQuotaData({ askConfirmation, onFetched }: QuotaDataOptions) {
  const { locale, t } = useI18n();
  const quotas = useQuotaCache();
  const now = useNow(NOW_TICK_MS);
  const source = useDataSource(credentialsSource);
  const snapshot: FileSnapshot = useMemo(() => ({
    files: (source.data?.files ?? []).filter(file => providerForFile(file)),
    receivedAtMs: source.data?.receivedAtMs ?? 0, observedAt: source.data?.observedAt,
  }), [source.data]);
  const loading = source.loading;
  const loadError = source.error;
  const setSnapshot = credentialsSource.mutate;
  const [actionError, setActionError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  const onFetchedRef = useRef(onFetched);
  onFetchedRef.current = onFetched;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadFiles = useCallback((_showSpinner = true) => credentialsSource.refresh(), []);
  useEffect(() => {
    if (!source.data) return;
    pruneQuotaCache(new Set(source.data.files.map(quotaKey)));
  }, [source.data]);

  const accounts = useMemo(() => {
    const list = snapshot.files.flatMap((file) => {
      const account = buildAccount(file, quotas[quotaKey(file)] ?? idleQuota(), now, locale, snapshot);
      return account ? [account] : [];
    });
    return sortAccounts(list);
  }, [snapshot, quotas, now, locale]);

  // Forward every newly committed successful snapshot (lighting observes reset times from it).
  const seen = useRef<Record<string, QuotaState>>({});
  useEffect(() => {
    accounts.forEach((account) => {
      const previous = seen.current[account.key];
      seen.current[account.key] = account.quota;
      if (previous !== account.quota && account.quota.status === 'success') onFetchedRef.current?.(account, account.quota);
    });
  }, [accounts]);

  const markBusy = useCallback((key: string, busy: boolean) => {
    if (!mounted.current) return;
    setBusyKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const refreshOne = useCallback((account: QuotaAccount) => {
    if (!account.canFetch) return Promise.resolve();
    return refreshQuotaBatch([account.file]);
  }, []);
  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try { await refreshQuotaBatch(snapshot.files); }
    finally { if (mounted.current) setRefreshingAll(false); }
  }, [snapshot.files]);
  useEffect(() => {
    if (!loading) void refreshQuotaBatch(snapshot.files, true);
  }, [loading, snapshot.files]);

  const consumeReset = useQuotaReset(askConfirmation, setActionError);
  const resetQuota = useCallback((account: QuotaAccount) => consumeReset(account.file, account.quota), [consumeReset]);

  const setEnabled = useCallback(async (account: QuotaAccount, enabled: boolean) => {
    if (busyKeys.has(account.key)) return;
    markBusy(account.key, true);
    setActionError('');
    try {
      await setOAuthCredentialFileDisabled(account.file, !enabled);
      // Reflect the change immediately; the reload below is the authority.
      setSnapshot((current) => ({
        ...current!,
        files: (current?.files ?? []).map((file) => quotaKey(file) === account.key
          ? { ...file, disabled: !enabled, status: !enabled ? 'disabled' : readString(file, 'status') === 'disabled' ? 'active' : file.status }
          : file),
      }));
      await loadFiles(false);
    } catch (reason) {
      setActionError(errorText(reason));
    } finally {
      markBusy(account.key, false);
    }
  }, [busyKeys, loadFiles, markBusy]);

  const clearCooldown = useCallback(async (account: QuotaAccount) => {
    const authIndex = authFileCooldownResetIndex(account.file);
    if (!authIndex || busyKeys.has(account.key)) return;
    const confirmed = await askConfirmation({
      title: t('authFiles.cooldown.resetTitle'),
      message: t('authFiles.cooldown.resetConfirm', { name: account.fileName }),
      confirmText: t('authFiles.cooldown.resetButton'),
    });
    if (!confirmed || !mounted.current) return;
    markBusy(account.key, true);
    setActionError('');
    try {
      await resetAuthFileCooldown(authIndex);
      setSnapshot((current) => ({
        ...current!,
        files: (current?.files ?? []).map((file) => quotaKey(file) === account.key ? { ...file, cooldowns: [] } : file),
      }));
      setNotice(t('authFiles.cooldown.resetSuccess', { name: account.fileName }));
      await loadFiles(false);
    } catch (reason) {
      setActionError(t('authFiles.cooldown.resetFailed', { name: account.fileName, message: errorText(reason) }));
    } finally {
      markBusy(account.key, false);
    }
  }, [askConfirmation, busyKeys, loadFiles, markBusy, t]);

  const anyLoading = refreshingAll || Object.values(quotas).some((quota) => quota.status === 'loading');
  const canToggle = useCallback((account: QuotaAccount) =>
    account.toggleable && !busyKeys.has(account.key) && !readBoolean(account.file, 'runtime_only'), [busyKeys]);
  const healthOf = (account: QuotaAccount) => authFileHealth(account.file);

  return {
    accounts, loading, loadError, actionError, setActionError, notice, setNotice, now,
    anyLoading, refreshingAll, busyKeys, canToggle, healthOf,
    reload: loadFiles, refreshOne, refreshAll, resetQuota, setEnabled, clearCooldown,
  };
}
