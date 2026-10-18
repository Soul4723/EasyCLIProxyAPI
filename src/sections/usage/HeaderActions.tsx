import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CalendarRange } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Chip, IconButton, SegmentedControl } from '../../ui';
import { RelativeTime } from '../../ui/RelativeTime';
import { compactNumber, RANGES } from './format';
import type { CollectorStatus, UsageRange } from './types';
import { useUsage } from './UsageContext';

/** Collector status chip: "Collecting locally · N stored" / remote / waiting / error / paused (with resume). */
export function CollectorChip() {
  const { t } = useI18n();
  const { status, setStatus } = useUsage();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!status) return null;
  const count = compactNumber(status.totalRecords);
  const remote = status.connectionMode === 'remote';
  const resumable = status.state === 'paused' && status.targetRevision !== undefined;
  const label = status.state === 'collecting' ? t(remote ? 'sec.usage.collector.remote' : 'sec.usage.collector.local', { count })
    : status.state === 'waiting-core' ? t('sec.usage.collector.waiting')
    : status.state === 'paused' ? t('sec.usage.collector.paused') : t('sec.usage.collector.error');
  const tone = status.state === 'collecting' ? 'ok' : status.state === 'waiting-core' ? 'neutral' : 'danger';
  const resume = () => {
    setBusy(true); setFailed(false);
    invoke<CollectorStatus>('resume_usage_collection', { expectedOrigin: status.remoteOrigin, expectedRevision: status.targetRevision })
      .then(setStatus).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <span className="usage-collector" data-state={status.state} title={status.message}>
      <Chip tone={tone} size="sm">{label}</Chip>
      {status.state === 'collecting' && status.lastCollectedAt ? (
        <span className="usage-collector-last ec-muted"><RelativeTime value={status.lastCollectedAt} /></span>
      ) : null}
      {resumable ? <button type="button" className="usage-collector-resume" disabled={busy} onClick={resume}>{t('sec.usage.collector.resume')}</button> : null}
      {failed ? <span role="alert" className="usage-collector-error">{t('sec.usage.collector.resumeFailed')}</span> : null}
    </span>
  );
}

/** Period toggle shared by every tab (Overview/Requests/Prices read the same window). */
export function PeriodControl() {
  const { t } = useI18n();
  const { filters, setFilter } = useUsage();
  const labelOf = (r: UsageRange) => t(`sec.usage.period.${r}` as 'sec.usage.period.24h');
  return (
    <span className="usage-period">
      <SegmentedControl<UsageRange> size="sm" ariaLabel={t('sec.usage.period.label')} value={filters.range === 'custom' ? ('' as UsageRange) : filters.range}
        onChange={(v) => setFilter('range', v)} options={RANGES.map((r) => ({ value: r, label: labelOf(r) }))} />
      <IconButton label={t('sec.usage.period.custom')} icon={<CalendarRange size={16} />} size="sm" active={filters.range === 'custom'}
        onClick={() => setFilter('range', filters.range === 'custom' ? '24h' : 'custom')} />
    </span>
  );
}
