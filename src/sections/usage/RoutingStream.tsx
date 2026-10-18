import { useMemo, useState } from 'react';
import { Activity, Pause, Play, Radio } from 'lucide-react';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import {
  Button, Card, CardHeader, EmptyState, ErrorState, HBar, Masked, ProviderLogo, RelativeTime, SegmentedControl, Skeleton, StatusPill,
  providerInfo,
} from '../../ui';
import { compactDuration } from './format';
import { eventAuthIndex, serveCounts, useCandidateIndex, type Block, type CandidateGroup } from './RoutingData';
import type { UsageEventPage, UsageRecord } from './types';

type Props = { block: Block<UsageEventPage>; groups: CandidateGroup[] };

type Mode = 'live' | 'paused';

/** C: newest-first stream of recent requests with the account that served each, plus served-by share. */
export function RoutingStream({ block, groups }: Props) {
  const { t } = useI18n();
  const [frozen, setFrozen] = useState<UsageRecord[] | null>(null);
  const latest = block.data?.items ?? [];
  const shown = frozen ?? latest;
  const candidates = useCandidateIndex(groups);
  const share = useMemo(() => serveCounts(shown, groups).rows, [shown, groups]);
  const newCount = useMemo(() => {
    if (!frozen) return 0;
    const seen = new Set(frozen.map((e) => e.id));
    return latest.filter((e) => !seen.has(e.id)).length;
  }, [frozen, latest]);
  const mode: Mode = frozen ? 'paused' : 'live';
  const setMode = (next: Mode) => setFrozen(next === 'paused' ? latest : null);
  const showError = block.error;
  const topShare = share.slice(0, 6);

  return (
    <Card as="section" className="rt-card rt-stream" aria-label={t('sec.usage.routing.stream.title')}>
      <CardHeader
        title={t('sec.usage.routing.stream.title')}
        count={shown.length}
        icon={<Radio size={16} />}
        actions={(
          <SegmentedControl<Mode>
            size="sm"
            ariaLabel={t('sec.usage.routing.stream.follow')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'live', label: t('sec.usage.routing.stream.live'), icon: <Play size={12} /> },
              { value: 'paused', label: t('sec.usage.routing.stream.paused'), icon: <Pause size={12} /> },
            ]}
          />
        )}
      />
      {frozen && newCount > 0 ? (
        <Button size="xs" variant="outline" className="rt-newbar" onClick={() => setFrozen(null)} icon={<Play size={12} />}>
          {t('sec.usage.routing.stream.newResume', { count: newCount })}
        </Button>
      ) : null}
      {block.loading && block.data === null ? <Skeleton lines={6} height={26} /> : null}
      {showError ? <ErrorState title={t('sec.usage.routing.stream.error')} onRetry={block.reload} /> : null}
      {block.data !== null && shown.length === 0 ? (
        <EmptyState
          compact
          icon={<Activity size={20} />}
          title={t('sec.usage.routing.stream.empty')}
          action={<a className="rt-link" href={routeHref('agents')}>{t('sec.usage.routing.stream.emptyAction')}</a>}
        />
      ) : null}
      {topShare.length > 0 ? (
        <div className="rt-share">
          <span className="rt-share__title ec-muted">{t('sec.usage.routing.stream.share')}</span>
          <HBar
            ariaLabel={t('sec.usage.routing.stream.shareLabel')}
            max={shown.length}
            rows={topShare.map((row) => ({
              id: row.key,
              label: <Masked value={row.label} kind={row.labelIsFile ? 'identifier' : 'text'} identities={row.identities} />,
              value: row.count,
              color: providerInfo(row.provider).colorVar,
              valueLabel: <span className="ec-num">{row.count}</span>,
            }))}
          />
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="rt-events rt-scroll">
          {shown.map((event) => {
            const index = eventAuthIndex(event, candidates);
            const served = index ? candidates.get(index) : undefined;
            const provider = served?.provider ?? event.provider;
            const failed = event.failed;
            const result = event.canceled ? 'canceled' : failed ? 'failed' : 'success';
            return (
              <li key={event.id} className="rt-event" data-result={result}>
                <RelativeTime value={event.timestamp} className="rt-event__time ec-muted" />
                <span className="rt-event__model">
                  <ProviderLogo provider={provider} size={18} />
                  <span className="ec-trunc" title={event.model}>{event.model}</span>
                </span>
                <span className="rt-event__acct ec-trunc">
                  {served
                    ? <Masked value={served.label} kind={served.labelIsFile ? 'identifier' : 'text'} identities={served.identities} />
                    : event.source_display
                      ? <Masked value={event.source_display} />
                      : <span className="ec-muted">{t('sec.usage.routing.stream.unknownAccount')}</span>}
                </span>
                {result === 'success' ? (
                  <StatusPill status="available" size="sm" label={t('sec.usage.result.success')} />
                ) : result === 'canceled' ? (
                  <StatusPill status="limited" size="sm" label={t('sec.usage.result.canceled')} />
                ) : (
                  <StatusPill
                    status="error"
                    size="sm"
                    label={event.failure_status ? `${t('sec.usage.result.failed')} ${event.failure_status}` : t('sec.usage.result.failed')}
                  />
                )}
                <span className="rt-event__lat ec-num ec-muted" title={t('sec.usage.routing.stream.latency')}>{compactDuration(event.latency_ms)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
