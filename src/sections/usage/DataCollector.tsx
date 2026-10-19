import { useEffect, useState } from 'react';
import { invoke } from '../../services/usageApi';
import { Radio } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Card, CardHeader, Chip, ErrorState, Masked, RelativeTime, Skeleton } from '../../ui';
import { compactNumber } from './format';
import type { DataNotice } from './DataStorage';
import type { CollectorStatus } from './types';
import { useUsage } from './UsageContext';
import { settingFieldRoute } from '../../services/settingsNavigation';

/** Redis usage-queue retention (seconds), read-only; edited under Settings → Logs. null = field unavailable. */
function useRedisRetention(refreshVersion: number) {
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<{ redisUsageQueueRetentionSeconds?: number }>('get_core_config_settings')
      .then((c) => { if (!cancelled && typeof c.redisUsageQueueRetentionSeconds === 'number') { setSeconds(c.redisUsageQueueRetentionSeconds); setError(''); } })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [refreshVersion]);
  return { seconds, error };
}

/** Collector card: read-only state from the shared status, plus Resume when paused. Mirrors CollectorChip in HeaderActions.tsx. */
export function DataCollector({ onNotice }: { onNotice: (notice: DataNotice) => void }) {
  const { t } = useI18n();
  const { status, setStatus, manualVersion, refresh } = useUsage();
  const [resuming, setResuming] = useState(false);
  const { seconds: redis, error } = useRedisRetention(manualVersion);

  if (!status) {
    return (
      <Card as="section" className="data-card" aria-label={t('sec.usage.data.collector.title')}>
        <CardHeader title={t('sec.usage.data.collector.title')} icon={<Radio size={14} />} />
        <Skeleton lines={4} height={18} />
      </Card>
    );
  }

  const remote = status.connectionMode === 'remote';
  const paused = status.state === 'paused';
  const resumeReason = status.targetRevision === undefined ? t('sec.usage.data.collector.resumeReason') : null;
  const tone = status.state === 'collecting' ? 'ok' : status.state === 'paused' ? 'warn' : status.state === 'error' ? 'danger' : 'neutral';
  const label = status.state === 'collecting'
    ? t(remote ? 'sec.usage.collector.remote' : 'sec.usage.collector.local', { count: compactNumber(status.totalRecords) })
    : status.state === 'waiting-core' ? t('sec.usage.collector.waiting')
      : status.state === 'paused' ? t('sec.usage.collector.paused') : t('sec.usage.collector.error');

  const resume = () => {
    if (resumeReason) return;
    setResuming(true);
    invoke<CollectorStatus>('resume_usage_collection', {
      expectedOrigin: status.remoteOrigin ?? null,
      expectedRevision: status.targetRevision,
    })
      .then((next) => {
        setStatus(next);
        onNotice({ tone: 'ok', text: t('sec.usage.data.resumed') });
      })
      .catch(() => onNotice({ tone: 'error', text: t('sec.usage.data.error.action') }))
      .finally(() => setResuming(false));
  };

  return (
    <Card as="section" className="data-card" aria-label={t('sec.usage.data.collector.title')}>
      <CardHeader title={t('sec.usage.data.collector.title')} icon={<Radio size={14} />} />
      <div className="data-collector-head">
        <Chip tone={tone} size="sm">{label}</Chip>
        {paused ? (
          <span className="data-tip" title={resumeReason ?? undefined}>
            <Button variant="secondary" size="sm" loading={resuming} disabled={resumeReason !== null} onClick={resume}>
              {t('sec.usage.collector.resume')}
            </Button>
          </span>
        ) : null}
      </div>
      {error ? <ErrorState title={t('sec.usage.error.load')} message={error} onRetry={refresh} /> : null}
      <p className="data-message"><Masked value={status.message} /></p>
      <dl className="data-rows">
        <dt>{t('sec.usage.data.collector.mode')}</dt>
        <dd>{t(remote ? 'sec.usage.data.collector.modeRemote' : 'sec.usage.data.collector.modeLocal')}</dd>
        {remote && status.remoteOrigin ? (
          <>
            <dt>{t('sec.usage.data.collector.origin')}</dt>
            <dd><Masked value={status.remoteOrigin} /></dd>
          </>
        ) : null}
        <dt>{t('sec.usage.data.collector.total')}</dt>
        <dd>{compactNumber(status.totalRecords)}</dd>
        <dt>{t('sec.usage.data.collector.last')}</dt>
        <dd>{status.lastCollectedAt ? <RelativeTime value={status.lastCollectedAt} /> : t('sec.usage.data.collector.never')}</dd>
        {redis !== null ? (
          <>
            <dt>{t('sec.usage.data.redis.label')}</dt>
            <dd>{t('sec.usage.data.redis.value', { seconds: redis })} · <a href={`#${settingFieldRoute('observability.usage.redis-usage-queue-retention-seconds')}`}>{t('sec.usage.data.redis.edit')}</a></dd>
          </>
        ) : null}
      </dl>
    </Card>
  );
}
