import { CheckCircle2, ChevronRight, RotateCcw, Timer, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { providerInfo } from '../../ui';
import { Card, CardHeader, Countdown, EmptyState, Masked, ProviderLogo, RelativeTime, Skeleton, StatusPill, type CredentialStatus } from '../../ui';
import { routeHref } from '../../shell/router';
import { groupByDay, type ComingKind, type ComingUp, type NeedsAction, type NeedsKind } from './model';

const NEEDS_STATUS: Record<Exclude<NeedsKind, 'light'>, CredentialStatus> = {
  expired: 'expired', error: 'error', exhausted: 'exhausted', cooldown: 'cooldown',
};

const COMING_ICON: Record<ComingKind, typeof Timer> = { reset: RotateCcw, cooldown: Timer, light: Zap };

const clock = (at: number, locale?: string) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

const MAX_NEEDS = 8;

export type NeedsActionCardProps = {
  rows: NeedsAction[];
  loading: boolean;
  /** The credentials list could not be read; an empty list would otherwise look like "all fine". */
  error: string;
};

/** Needs-action: one line per item (kind pill · provider · account · detail · time) linking to the item's home. */
export function NeedsActionCard({ rows, loading, error }: NeedsActionCardProps) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const maskedTitle = (value: string, identities: string[]) => mask.text(value, identities);
  const shown = rows.slice(0, MAX_NEEDS);
  return (
    <Card as="section" className="ov-needs" aria-labelledby="ov-needs-title" data-testid="ov-needs">
      <CardHeader title={<span id="ov-needs-title">{t('sec.overview.needsAction')}</span>} count={rows.length || undefined} />
      {loading ? (
        <div aria-busy="true"><Skeleton lines={3} height={30} /></div>
      ) : error ? (
        <p className="ov-error" role="alert">{error}</p>
      ) : rows.length === 0 ? (
        <p className="ov-calm" data-testid="ov-needs-empty"><CheckCircle2 size={16} aria-hidden="true" />{t('sec.overview.allGood')}</p>
      ) : (
        <ul className="ov-rows">
          {shown.map((row) => (
            <li key={row.id}>
              <a className="ov-row" href={routeHref(row.to.page, null, row.to.params)} data-kind={row.kind}>
                {row.kind === 'light'
                  ? <span className="ov-kind ov-kind--light"><Zap size={11} aria-hidden="true" />{t('sec.overview.kind.light')}</span>
                  : <StatusPill status={NEEDS_STATUS[row.kind]} size="sm" label={t(`sec.overview.kind.${row.kind}`)} />}
                <ProviderLogo provider={row.provider} size={18} />
                <span className="ov-row__main ec-trunc" title={row.raw ? maskedTitle(row.raw, row.identities) : undefined}>
                  <Masked value={row.account} identities={row.identities} />
                  {(row.reason || row.detail) && <span className="ov-row__detail"> · {row.reason ? t(`sec.overview.reason.${row.reason}`) : <Masked value={row.detail} identities={row.identities} />}</span>}
                </span>
                {row.at !== null && (
                  <span className="ov-row__when ec-num">
                    {row.kind === 'light' ? <RelativeTime value={row.at} /> : <><span className="ov-row__verb">{t('sec.overview.resetsIn')} </span><Countdown to={row.at} compact /></>}
                  </span>
                )}
                <ChevronRight size={14} aria-hidden="true" className="ov-row__go" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown.length && (
        <a className="ov-more" href={routeHref('quota')}>{t('sec.overview.more', { count: rows.length - shown.length })} →</a>
      )}
    </Card>
  );
}

export type ComingUpCardProps = { events: ComingUp[]; loading: boolean; nowMs: number };

const MAX_COMING = 5;

/** Coming up: next resets, scheduled lights and cooldown ends, grouped today / tomorrow / later. */
export function ComingUpCard({ events, loading, nowMs }: ComingUpCardProps) {
  const { t, locale } = useI18n();
  const shown = events.slice(0, MAX_COMING);
  const groups = groupByDay(shown, nowMs);
  return (
    <Card as="section" className="ov-coming" aria-labelledby="ov-coming-title" data-testid="ov-coming">
      <CardHeader title={<span id="ov-coming-title">{t('sec.overview.comingUp')}</span>} count={events.length || undefined} />
      {loading ? (
        <div aria-busy="true"><Skeleton lines={3} height={30} /></div>
      ) : events.length === 0 ? (
        <EmptyState compact icon={<Timer size={20} />} title={t('sec.overview.nothingComing')} />
      ) : (
        groups.map((group) => (
          <div key={group.bucket} className="ov-day">
            <h4 className="ov-day__title">{t(`sec.overview.day.${group.bucket}`)}</h4>
            <ul className="ov-rows">
              {group.items.map((event) => {
                const Icon = COMING_ICON[event.kind];
                return (
                  <li key={event.id}>
                    <a className="ov-row ov-row--event" href={routeHref(event.to.page, null, event.to.params)} data-kind={event.kind}>
                      <span className="ov-time ec-num">
                        <strong>{clock(event.at, locale)}</strong>
                        <small><Countdown to={event.at} compact /></small>
                      </span>
                      <span className={`ov-event-icon ov-event-icon--${event.kind}`}><Icon size={13} aria-hidden="true" /></span>
                      <ProviderLogo provider={event.provider} size={18} />
                      <span className="ov-row__main ec-trunc">
                        {event.count > 1
                          ? <span>{t('sec.overview.event.many', { count: event.count, provider: providerInfo(event.provider).name })}</span>
                          : <Masked value={event.account} identities={event.identities} />}
                        <span className="ov-row__detail"> · {t(`sec.overview.event.${event.kind}`, { window: event.detail })}</span>
                      </span>
                      <ChevronRight size={14} aria-hidden="true" className="ov-row__go" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      {events.length > shown.length && <a className="ov-more" href={routeHref('quota')}>{t('sec.overview.more', { count: events.length - shown.length })} →</a>}
    </Card>
  );
}
