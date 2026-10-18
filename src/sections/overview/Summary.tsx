import { Check, KeyRound, LogIn, Plug, Play, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { HomeUsageSummary } from '../../services/homeOverview';
import { Button, Card, CardHeader, IconButton, ProviderLogo, ProviderName, QuotaBar, Skeleton, Sparkline, StatTile, formatCompactNumber, formatPercent, providerInfo, quotaTone } from '../../ui';
import { navigate, routeHref } from '../../shell/router';
import type { ProviderQuotaSummary } from './model';

export type ProviderRowProps = {
  providers: ProviderQuotaSummary[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
};

/** Compact provider row: logo + one % per provider; each tile links to its Quota group. No bars, counts or windows here. */
export function ProviderRow({ providers, loading, refreshing, onRefresh }: ProviderRowProps) {
  const { t } = useI18n();
  return (
    <section className="ov-providers" aria-label={t('sec.overview.providers')} data-testid="ov-providers">
      <header className="ov-providers__head">
        <h3>{t('sec.overview.quota')}</h3>
        <IconButton label={t('sec.overview.refreshQuota')} icon={<RefreshCw size={14} className={refreshing ? 'ec-spin' : undefined} />} size="sm" disabled={refreshing || providers.length === 0} onClick={onRefresh} />
        <a className="ov-link" href={routeHref('quota')}>{t('sec.overview.allAccounts')} →</a>
      </header>
      {loading ? (
        <div className="ov-providers__grid" aria-busy="true"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} /></div>
      ) : (
        <div className="ov-providers__grid">
          {providers.map((summary) => {
            const tone = summary.leftPct === null ? null : quotaTone(summary.leftPct);
            return (
              <a key={summary.provider} className="ov-provider" href={routeHref('quota', null, { provider: summary.provider })} data-provider={summary.provider} style={{ ['--ov-provider' as string]: providerInfo(summary.provider).colorVar }}>
                <span className="ov-provider__id"><ProviderLogo provider={summary.provider} size={18} /><ProviderName provider={summary.provider} /></span>
                <span className={`ov-provider__pct ov-provider__pct--${tone ?? 'none'}`} data-testid={`ov-pct-${summary.provider}`}>
                  {summary.leftPct === null ? '—' : formatPercent(summary.leftPct)}
                </span>
                <QuotaBar leftPct={summary.leftPct} height={4} label={t('sec.overview.quotaLeft')} />
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}

export type UsageTileProps = { usage: HomeUsageSummary | null; series: number[]; loading: boolean; error: string };

/** One usage tile: requests 24h + success rate + sparkline → Usage. */
export function UsageTile({ usage, series, loading, error }: UsageTileProps) {
  const { t } = useI18n();
  if (loading) return <Card className="ov-usage"><Skeleton height={72} /></Card>;
  const rate = usage?.successRate;
  return (
    <div className="ov-usage" data-testid="ov-usage">
      <StatTile
        href={routeHref('usage')}
        label={t('sec.overview.requests24h')}
        value={error ? '—' : formatCompactNumber(usage?.totalRequests ?? 0)}
        hint={error ? t('sec.overview.usageError') : rate === null || rate === undefined ? t('sec.overview.noRate') : `${formatPercent(rate)} ${t('sec.overview.success')}`}
        trend={series.length > 1 ? <Sparkline values={series} width={120} height={32} fill ariaLabel={t('sec.overview.requests24h')} /> : undefined}
      />
    </div>
  );
}

export type OnboardingProps = {
  remote: boolean;
  coreReady: boolean;
  coreInstalled: boolean;
  starting: boolean;
  hasCredentials: boolean;
  onStart: () => void;
};

type Step = { id: string; icon: ReactNode; label: string; done: boolean; locked?: string; action: ReactNode };

/** First-run onboarding (replaces Easy Mode): ordered steps that link to the real homes; nothing is configured here. */
export function Onboarding({ remote, coreReady, coreInstalled, starting, hasCredentials, onStart }: OnboardingProps) {
  const { t } = useI18n();
  const gate = coreReady ? undefined : t('sec.overview.startFirst');
  const steps: Step[] = [
    ...(remote ? [] : [{
      id: 'core', icon: <Play size={16} />, label: t('sec.overview.step.core'), done: coreReady,
      locked: coreInstalled ? undefined : t('sec.overview.notInstalledReason'),
      action: <Button size="sm" variant="primary" loading={starting} disabled={!coreInstalled || coreReady} onClick={onStart}>{t('sec.overview.start')}</Button>,
    } satisfies Step]),
    {
      id: 'signin', icon: <LogIn size={16} />, label: t('sec.overview.step.signin'), done: hasCredentials, locked: gate,
      action: <Button size="sm" variant="secondary" disabled={!coreReady} onClick={() => navigate('/providers')}>{t('sec.overview.open')}</Button>,
    },
    {
      id: 'apikey', icon: <KeyRound size={16} />, label: t('sec.overview.step.apikey'), done: false, locked: gate,
      action: <Button size="sm" variant="secondary" disabled={!coreReady} onClick={() => navigate('/providers')}>{t('sec.overview.open')}</Button>,
    },
    {
      id: 'agent', icon: <Plug size={16} />, label: t('sec.overview.step.agent'), done: false,
      action: <Button size="sm" variant="secondary" onClick={() => navigate('/agents')}>{t('sec.overview.open')}</Button>,
    },
  ];
  return (
    <Card as="section" className="ov-onboarding" aria-labelledby="ov-onboarding-title" data-testid="ov-onboarding">
      <CardHeader title={<span id="ov-onboarding-title">{t('sec.overview.getStarted')}</span>} />
      <ol className="ov-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={`ov-step${step.done ? ' is-done' : ''}`} data-step={step.id} title={step.locked}>
            <span className="ov-step__num">{step.done ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
            <span className="ov-step__icon" aria-hidden="true">{step.icon}</span>
            <span className="ov-step__label">{step.label}</span>
            {step.done ? <span className="ov-muted">{t('sec.overview.done')}</span> : step.action}
          </li>
        ))}
      </ol>
    </Card>
  );
}
