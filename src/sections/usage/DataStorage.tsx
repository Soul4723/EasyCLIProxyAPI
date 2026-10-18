import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '../../services/usageApi';
import { HardDrive, Wrench, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Card, CardHeader, Chip, ConfirmDialog, CopyButton, EmptyState, ErrorState, IconButton, Masked, ProgressBar, Skeleton, cx } from '../../ui';
import { compactNumber, formatStorageBytes } from './format';
import type { UsageRepairResult, UsageStorageSettings } from './types';
import { useUsage } from './UsageContext';

const MB = 1024 * 1024;

/** Accepts a positive whole number of MB, the same rule the old Data Management page used. */
const parseMb = (draft: string) => {
  const normalized = draft.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export type DataNotice = { tone: 'ok' | 'error'; text: string };

/** One notice at a time; clears itself after 6s. */
export function useDataNotice() {
  const [notice, setNotice] = useState<DataNotice | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const showNotice = useCallback((next: DataNotice) => {
    window.clearTimeout(timer.current);
    setNotice(next);
    timer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);
  const dismissNotice = useCallback(() => {
    window.clearTimeout(timer.current);
    setNotice(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { notice, showNotice, dismissNotice };
}

export function DataNoticeLine({ notice, onDismiss }: { notice: DataNotice; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div className={cx('data-notice', `data-notice--${notice.tone}`)} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <IconButton size="xs" icon={<X size={12} />} label={t('sec.usage.data.dismiss')} onClick={onDismiss} />
    </div>
  );
}

function DataStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="data-stat">
      <span className="data-stat-label">{label}</span>
      <span className="data-stat-value">{value}</span>
    </div>
  );
}

/** Storage card (size, limit editor) and maintenance card (shrink, repair). */
export function DataStorage({ onNotice }: { onNotice: (notice: DataNotice) => void }) {
  const { t } = useI18n();
  const { tick } = useUsage();
  const [storage, setStorage] = useState<UsageStorageSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState('');
  const [limitInvalid, setLimitInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shrinkDraft, setShrinkDraft] = useState('');
  const [shrinking, setShrinking] = useState(false);
  const [confirmShrink, setConfirmShrink] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairResult, setRepairResult] = useState<UsageRepairResult | null>(null);
  const requestId = useRef(0);
  const seeded = useRef(false);

  // Each accepted response bumps the id so an older in-flight load cannot overwrite it.
  const applyStorage = (next: UsageStorageSettings) => {
    requestId.current += 1;
    setStorage(next);
    setLoadError(null);
  };

  const load = useCallback(() => {
    const id = ++requestId.current;
    invoke<UsageStorageSettings>('get_usage_storage_settings')
      .then((next) => {
        if (id !== requestId.current) return;
        setStorage(next);
        setLoadError(null);
        if (!seeded.current) {
          seeded.current = true;
          setLimitDraft(String(next.maxDatabaseSizeMb));
        }
      })
      .catch((error: unknown) => {
        if (id === requestId.current) setLoadError(String(error));
      });
  }, []);

  // Quiet refresh on every tick: previous data stays on screen while the request runs.
  useEffect(() => { load(); }, [load, tick]);

  const limitMb = parseMb(limitDraft);
  const saveLimit = () => {
    if (limitMb === null) {
      setLimitInvalid(true);
      onNotice({ tone: 'error', text: t('sec.usage.data.storage.invalid') });
      return;
    }
    setLimitInvalid(false);
    setSaving(true);
    invoke<UsageStorageSettings>('save_usage_storage_settings', { maxDatabaseSizeMb: limitMb })
      .then((next) => {
        applyStorage(next);
        onNotice({
          tone: 'ok',
          text: next.deletedRecords > 0
            ? t('sec.usage.data.storage.savedCleanup', { deleted: compactNumber(next.deletedRecords) })
            : t('sec.usage.data.storage.saved'),
        });
      })
      .catch(() => onNotice({ tone: 'error', text: t('sec.usage.data.error.action') }))
      .finally(() => setSaving(false));
  };

  const shrinkMb = parseMb(shrinkDraft);
  const shrinkBlocked = !storage || shrinkMb === null || shrinkMb * MB >= storage.databaseSizeBytes;
  const shrinkReason = !storage ? null
    : shrinkMb === null ? t('sec.usage.data.storage.invalid')
      : shrinkBlocked ? t('sec.usage.data.shrink.disabledReason', { size: formatStorageBytes(storage.databaseSizeBytes) })
        : null;

  const shrink = () => {
    if (shrinkMb === null) return;
    setShrinking(true);
    invoke<UsageStorageSettings>('shrink_usage_database', { targetDatabaseSizeMb: shrinkMb })
      .then((next) => {
        applyStorage(next);
        setConfirmShrink(false);
        onNotice({
          tone: 'ok',
          text: next.deletedRecords > 0
            ? t('sec.usage.data.shrink.done', { deleted: compactNumber(next.deletedRecords), size: formatStorageBytes(next.databaseSizeBytes) })
            : t('sec.usage.data.shrink.noCleanup'),
        });
      })
      .catch(() => {
        setConfirmShrink(false);
        onNotice({ tone: 'error', text: t('sec.usage.data.error.action') });
      })
      .finally(() => setShrinking(false));
  };

  const repair = () => {
    setRepairing(true);
    invoke<UsageRepairResult>('repair_usage_cache_records')
      .then((result) => {
        setRepairResult(result);
        setConfirmRepair(false);
        onNotice({
          tone: 'ok',
          text: t('sec.usage.data.repair.done', { repaired: compactNumber(result.repaired), deleted: compactNumber(result.deleted) }),
        });
        // The repair already succeeded; a failed storage re-fetch is retried by the next tick instead of reported as an error.
        return invoke<UsageStorageSettings>('get_usage_storage_settings').then(applyStorage, () => undefined);
      }, () => {
        setConfirmRepair(false);
        onNotice({ tone: 'error', text: t('sec.usage.data.error.action') });
      })
      .finally(() => setRepairing(false));
  };

  const pct = storage && storage.maxDatabaseSizeMb > 0
    ? Math.round((storage.databaseSizeBytes / (storage.maxDatabaseSizeMb * MB)) * 100)
    : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';

  return (
    <>
      <Card as="section" className="data-card" aria-label={t('sec.usage.data.storage.title')}>
        <CardHeader title={t('sec.usage.data.storage.title')} icon={<HardDrive size={14} />} />
        {!storage && loadError ? (
          <ErrorState title={t('sec.usage.error.load')} message={loadError} onRetry={load} retryLabel={t('sec.usage.retry')} />
        ) : null}
        {!storage && !loadError ? <Skeleton lines={3} height={18} /> : null}
        {storage ? (
          <>
            <div className="data-stats">
              <DataStat label={t('sec.usage.data.storage.size')} value={formatStorageBytes(storage.databaseSizeBytes)} />
              <DataStat label={t('sec.usage.data.storage.total')} value={compactNumber(storage.totalRecords)} />
              <DataStat label={t('sec.usage.data.storage.deleted')} value={compactNumber(storage.deletedRecords)} />
            </div>
            <ProgressBar value={Math.min(100, pct)} tone={tone} label={t('sec.usage.data.storage.used', { pct })} />
            {storage.totalRecords === 0 ? <EmptyState compact title={t('sec.usage.data.storage.empty')} /> : null}
            <form className="data-limit" onSubmit={(event) => { event.preventDefault(); saveLimit(); }}>
              <label className="data-field">
                <span>{t('sec.usage.data.storage.maxLabel')}</span>
                <input
                  className="data-input"
                  inputMode="numeric"
                  value={limitDraft}
                  aria-invalid={limitInvalid || undefined}
                  onChange={(event) => { setLimitDraft(event.target.value); setLimitInvalid(false); }}
                />
              </label>
              <Button type="submit" variant="primary" size="sm" loading={saving}>{t('sec.usage.data.storage.save')}</Button>
            </form>
          </>
        ) : null}
      </Card>

      <Card as="section" className="data-card" aria-label={t('sec.usage.data.maint.title')}>
        <CardHeader title={t('sec.usage.data.maint.title')} icon={<Wrench size={14} />} />
        {storage ? (
          <>
            <div className="data-action">
              <strong>{t('sec.usage.data.shrink.title')}</strong>
              <div className="data-action-row">
                <label className="data-field">
                  <span>{t('sec.usage.data.shrink.target')}</span>
                  <input
                    className="data-input"
                    inputMode="numeric"
                    value={shrinkDraft}
                    placeholder={String(Math.max(1, Math.floor(storage.databaseSizeBytes / 1048576 / 2)))}
                    onChange={(event) => setShrinkDraft(event.target.value)}
                  />
                </label>
                <span className="data-tip" title={shrinkReason ?? undefined}>
                  <Button variant="danger" size="sm" disabled={shrinkBlocked} onClick={() => setConfirmShrink(true)}>
                    {t('sec.usage.data.shrink.action')}
                  </Button>
                </span>
              </div>
            </div>
            <div className="data-action">
              <div className="data-action-row data-action-row--split">
                <strong>{t('sec.usage.data.repair.title')}</strong>
                <Button variant="outline" size="sm" loading={repairing} onClick={() => setConfirmRepair(true)}>
                  {t('sec.usage.data.repair.action')}
                </Button>
              </div>
              {repairResult ? (
                <div className="data-repair">
                  <Chip tone="neutral" size="sm">{t('sec.usage.data.repair.scanned')} {compactNumber(repairResult.scanned)}</Chip>
                  <Chip tone="ok" size="sm">{t('sec.usage.data.repair.repaired')} {compactNumber(repairResult.repaired)}</Chip>
                  <Chip tone="warn" size="sm">{t('sec.usage.data.repair.deleted')} {compactNumber(repairResult.deleted)}</Chip>
                  {repairResult.backupPath ? (
                    <span className="data-backup">
                      <span className="ec-muted">{t('sec.usage.data.repair.backup')}</span>
                      <Masked value={repairResult.backupPath} />
                      <CopyButton value={repairResult.backupPath} label={t('sec.usage.data.repair.backup')} size="sm" variant="ghost" />
                    </span>
                  ) : (
                    <span className="ec-muted">{t('sec.usage.data.repair.noBackup')}</span>
                  )}
                </div>
              ) : null}
            </div>
          </>
        ) : <Skeleton lines={4} height={28} />}
      </Card>

      <ConfirmDialog
        open={confirmShrink}
        danger
        title={t('sec.usage.data.shrink.confirmTitle')}
        message={shrinkMb === null ? '' : t('sec.usage.data.shrink.confirm', { size: formatStorageBytes(shrinkMb * MB) })}
        confirmLabel={t('sec.usage.data.shrink.action')}
        busy={shrinking}
        onConfirm={shrink}
        onCancel={() => setConfirmShrink(false)}
      />
      <ConfirmDialog
        open={confirmRepair}
        title={t('sec.usage.data.repair.confirmTitle')}
        message={t('sec.usage.data.repair.confirm')}
        confirmLabel={t('sec.usage.data.repair.action')}
        busy={repairing}
        onConfirm={repair}
        onCancel={() => setConfirmRepair(false)}
      />
    </>
  );
}
