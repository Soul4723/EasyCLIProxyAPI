import { useState } from 'react';
import { invoke } from '../../services/usageApi';
import { CalendarRange, PauseCircle, Radio, WifiOff } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Chip, IconButton, SegmentedControl, type ChipTone } from '../../ui';
import { formatRecordTime } from './collectionState';
import { compactNumber, RANGES } from './format';
import type { CollectorStatus, UsageRange } from './types';
import { useUsage } from './UsageContext';

/** Same wording for the header chip and the Data collector card. Only `collecting` is styled as live. */
export function useCollectionLabel() {
  const { t } = useI18n();
  const { status, collection } = useUsage();
  if (!status) return null;
  const count = compactNumber(status.totalRecords);
  const remote = status.connectionMode === 'remote';
  const { kind } = collection;
  const base = kind === 'collecting' ? t(remote ? 'sec.usage.collector.remote' : 'sec.usage.collector.local', { count })
    : kind === 'stopped' ? t('sec.usage.collector.stopped')
    : kind === 'unreachable' ? t('sec.usage.collector.unreachable')
    : kind === 'paused' ? t('sec.usage.collector.paused')
    : kind === 'error' ? t('sec.usage.collector.error') : t('sec.usage.collector.waiting');
  const stale = kind === 'stopped' || kind === 'unreachable';
  const time = stale ? formatRecordTime(collection.lastCollectedAt) : null;
  const label = time ? `${base} · ${t('sec.usage.collector.lastRecord', { time })}` : base;
  const tone: ChipTone = kind === 'collecting' ? 'ok' : kind === 'error' ? 'danger' : kind === 'paused' || stale ? 'warn' : 'neutral';
  const icon = kind === 'collecting' ? <Radio size={12} /> : kind === 'unreachable' ? <WifiOff size={12} /> : kind === 'stopped' ? <PauseCircle size={12} /> : undefined;
  return { label, tone, icon, kind };
}

/** Collector status chip: collecting / core stopped or unreachable (history kept, last record) / waiting / error / paused (with resume). */
export function CollectorChip() {
  const { t } = useI18n();
  const { status, setStatus } = useUsage();
  const state = useCollectionLabel();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!status || !state) return null;
  const resumable = status.state === 'paused' && status.targetRevision !== undefined;
  const resume = () => {
    setBusy(true); setFailed(false);
    invoke<CollectorStatus>('resume_usage_collection', { expectedOrigin: status.remoteOrigin, expectedRevision: status.targetRevision })
      .then(setStatus).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <span className="usage-collector" data-state={state.kind} data-live={state.kind === 'collecting'} title={status.message}>
      <Chip tone={state.tone} size="sm" icon={state.icon}>{state.label}</Chip>
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
