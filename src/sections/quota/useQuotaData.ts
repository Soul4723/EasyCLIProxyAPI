// Data + actions for the quota page. Wraps the real services: /credentials (management API), quotaService
// (provider quota via the core request proxy), quotaCache, reset-credit actions, credential enable/disable and
// cooldown clear. No new backend behaviour.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ConfirmationOptions } from '../../components/ConfirmationDialog';
import { useQuotaReset } from '../../components/useQuotaReset';
import { authFileHealth } from '../../services/authFileHealth';
import {
  authFileCooldownResetIndex, dedupeAuthFiles, resetAuthFileCooldown, setOAuthCredentialFileDisabled,
} from '../../services/authFiles';
import { managementApi, readBoolean, readString, responseList } from '../../services/managementApi';
import { assertQuotaOperation, startQuotaOperation } from '../../services/quotaOperation';
import {
  captureQuotaCacheGeneration, getQuotaCacheSnapshot, pruneQuotaCache, updateQuotaCache, useQuotaCache,
} from '../../services/quotaCache';
import { commitFetchedQuota } from '../../services/quotaEnrichment';
import {
  idleQuota, loadQuota, providerForFile, quotaKey, type AuthFile, type QuotaState,
} from '../../services/quotaService';
import { useNow } from '../../ui';
import { buildAccount, sortAccounts, type QuotaAccount } from './model';

const REFRESH_CONCURRENCY = 4;
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
  const [snapshot, setSnapshot] = useState<FileSnapshot>({ files: [], receivedAtMs: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  const filesRequest = useRef(0);
  const onFetchedRef = useRef(onFetched);
  onFetchedRef.current = onFetched;
  useEffect(() => () => { mounted.current = false; }, []);

  const loadFiles = useCallback(async (showSpinner = true) => {
    const request = ++filesRequest.current;
    if (showSpinner) setLoading(true);
    setLoadError(null);
    try {
      const payload = await managementApi.get('/credentials');
      if (!mounted.current || request !== filesRequest.current) return;
      const all = dedupeAuthFiles(responseList(payload, 'files'));
      const files = all.filter((file) => providerForFile(file));
      setSnapshot({ files, receivedAtMs: Date.now(), observedAt: readString(payload, 'observed_at') || undefined });
      pruneQuotaCache(new Set(all.map(quotaKey)));
      updateQuotaCache((current) => {
        const next = { ...current };
        files.forEach((file) => {
          const key = quotaKey(file);
          if (!next[key]) next[key] = idleQuota();
        });
        return next;
      });
    } catch (reason) {
      if (mounted.current && request === filesRequest.current) setLoadError(errorText(reason));
    } finally {
      if (mounted.current && request === filesRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

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

  const refreshOne = useCallback(async (account: QuotaAccount) => {
    if (!account.canFetch || getQuotaCacheSnapshot()[account.key]?.status === 'loading') return;
    const generation = captureQuotaCacheGeneration();
    updateQuotaCache((current) => ({ ...current, [account.key]: { ...(current[account.key] ?? idleQuota()), status: 'loading' } }));
    const result = await loadQuota(account.file).catch((error): QuotaState => ({ status: 'error', rows: [], error: errorText(error) }));
    await commitFetchedQuota(generation, account.file, result);
  }, []);

  const refreshAll = useCallback(async () => {
    if (Object.values(getQuotaCacheSnapshot()).some((quota) => quota.status === 'loading')) return;
    const targets = accounts.filter((account) => account.canFetch);
    if (!targets.length) return;
    setRefreshingAll(true);
    setActionError('');
    const generation = captureQuotaCacheGeneration();
    const operation = startQuotaOperation();
    void operation.catch(() => undefined);
    updateQuotaCache((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((account) => [account.key, { ...(current[account.key] ?? idleQuota()), status: 'loading' as const }])),
    }));
    try {
      for (let index = 0; index < targets.length; index += REFRESH_CONCURRENCY) {
        assertQuotaOperation(await operation);
        await Promise.all(targets.slice(index, index + REFRESH_CONCURRENCY).map(async (account) => {
          const result = await loadQuota(account.file, operation)
            .catch((error): QuotaState => ({ status: 'error', rows: [], error: errorText(error) }));
          await commitFetchedQuota(generation, account.file, result);
        }));
      }
    } catch (reason) {
      if (captureQuotaCacheGeneration() === generation) setActionError(errorText(reason));
    } finally {
      if (mounted.current) setRefreshingAll(false);
    }
  }, [accounts]);

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
        ...current,
        files: current.files.map((file) => quotaKey(file) === account.key
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
        ...current,
        files: current.files.map((file) => quotaKey(file) === account.key ? { ...file, cooldowns: [] } : file),
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
