import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useResource } from '../../services/useResource';
import { invoke } from '../../services/usageApi';
import { BarChart3, Ban } from 'lucide-react';
import { useI18n } from '../../i18n';
import { navigate, routePath } from '../../shell/router';
import { buildUsageTrendSeries, formatTrendAxisLabel, OTHER_TREND_MODEL_KEY } from '../../services/usageTrend';
import {
  AreaChart, Button, Card, CardHeader, ChartLegend, EmptyState, ErrorState, HBar, ProviderLogo, SegmentedControl, Skeleton,
  Sparkline, StatTile, formatPercent,
} from '../../ui';
import { providerInfo } from '../../ui/providers';
import type { UsageAnalysis, UsageCategory, UsageOverview } from './types';
import { compactDuration, compactNumber, formatUsd } from './format';
import { FilterBar } from './FilterBar';
import { emptyAnalysis, useUsage } from './UsageContext';
import './OverviewTab.css';

type Metric = 'tokens' | 'requests';
type TrendMode = 'tokens' | 'requests';

const MODEL_COLORS = ['var(--ec-s1)', 'var(--ec-s2)', 'var(--ec-s3)', 'var(--ec-s4)', 'var(--ec-s5)', 'var(--ec-s6)'];
const TOP_MODELS = 8;

const rank = (items: UsageCategory[], metric: Metric) =>
  [...items].sort((a, b) => b[metric] - a[metric] || b.requests - a.requests || a.key.localeCompare(b.key));

export function OverviewTab() {
  const { t } = useI18n();
  const { query, timeQuery, refreshVersion, loadAnalysis, activeFilterCount, resetFilters } = useUsage();
  const [reload, setReload] = useState(0);
  const snapshot = useResource(async () => {
    const [overview, analysis] = await Promise.all([
      invoke<UsageOverview>('get_usage_overview', { query }), loadAnalysis(query),
    ]);
    return { overview, analysis };
  }, [query, refreshVersion, loadAnalysis, reload]);
  const overview = snapshot.data?.overview ?? null;
  const analysis = snapshot.data?.analysis ?? emptyAnalysis;
  const failed = !!snapshot.error;
  const loading = snapshot.loading;

  const retry = useCallback(() => { setReload((n) => n + 1); }, []);

  let body: ReactNode;
  if (!overview && failed) {
    body = <ErrorState title={t('sec.usage.error.load')} onRetry={retry} retryLabel={t('sec.usage.retry')} />;
  } else if (!overview) {
    body = <OverviewSkeleton />;
  } else if (overview.totalRequests === 0) {
    body = (
      <EmptyState
        icon={<BarChart3 />}
        title={t('sec.usage.overview.empty')}
        action={activeFilterCount > 0 ? <Button variant="outline" size="sm" onClick={resetFilters}>{t('sec.usage.filter.reset')}</Button> : undefined}
      />
    );
  } else {
    body = <OverviewBody overview={overview} analysis={analysis} range={timeQuery} />;
  }

  return (
    <div className="ov" aria-busy={loading}>
      <FilterBar />
      {overview && failed ? <ErrorState title={t('sec.usage.error.load')} onRetry={retry} retryLabel={t('sec.usage.retry')} /> : null}
      {body}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="ov-skeleton" aria-hidden="true">
      <div className="ov-stats">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={86} radius="var(--ec-r-md)" />)}
      </div>
      <Skeleton height={260} radius="var(--ec-r-md)" />
      <div className="ov-pair">
        <Skeleton height={200} radius="var(--ec-r-md)" />
        <Skeleton height={200} radius="var(--ec-r-md)" />
      </div>
    </div>
  );
}

function OverviewBody({ overview, analysis, range }: { overview: UsageOverview; analysis: UsageAnalysis; range: { start?: string; end?: string } }) {
  const { t, locale } = useI18n();
  const series = useMemo(() => buildUsageTrendSeries(overview.timeline, range), [overview.timeline, range.start, range.end]);
  const requestSpark = series.points.map((p) => p.requests);
  const tokenSpark = series.points.map((p) => p.tokens);
  const unpriced = Math.max(0, overview.totalRequests - overview.pricedRequests);
  const hasSpeed = overview.tpsSampleCount > 0 && overview.tps > 0;

  return (
    <>
      <div className="ov-stats">
        <StatTile
          label={t('sec.usage.overview.stat.requests')}
          accent="var(--ec-s1)"
          value={compactNumber(overview.totalRequests)}
          hint={t('sec.usage.overview.hint.requests', { ok: compactNumber(overview.successCount), failed: compactNumber(overview.failureCount) })}
          trend={<Sparkline values={requestSpark} color="var(--ec-s1)" width={56} fill />}
        />
        <StatTile
          label={t('sec.usage.overview.stat.tokens')}
          accent="var(--ec-s2)"
          value={compactNumber(overview.totalTokens)}
          hint={t('sec.usage.overview.hint.tokens', { input: compactNumber(overview.inputTokens), output: compactNumber(overview.outputTokens) })}
          trend={<Sparkline values={tokenSpark} color="var(--ec-s2)" width={56} fill />}
        />
        <StatTile
          label={t('sec.usage.overview.stat.success')}
          accent="var(--ec-ok)"
          value={formatPercent(overview.successRate, 1, locale)}
          hint={t('sec.usage.overview.hint.success', { canceled: compactNumber(overview.canceledCount) })}
        />
        <StatTile
          label={t('sec.usage.overview.stat.cache')}
          accent="var(--ec-s4)"
          value={formatPercent(overview.cacheHitRate * 100, 1, locale)}
          hint={t('sec.usage.overview.hint.cache', { read: compactNumber(overview.cacheReadTokens), input: compactNumber(overview.inputTokens) })}
        />
        <StatTile
          label={t('sec.usage.overview.stat.speed')}
          accent="var(--ec-s3)"
          value={hasSpeed ? t('sec.usage.overview.tps', { value: overview.tps.toFixed(1) }) : '—'}
          hint={t('sec.usage.overview.hint.speed', { latency: overview.averageLatencyMs > 0 ? compactDuration(overview.averageLatencyMs) : '—' })}
        />
        <StatTile
          label={t('sec.usage.overview.stat.cost')}
          accent="var(--ec-s5)"
          value={
            <span title={t('sec.usage.overview.cost.tooltip')}>
              {`~${formatUsd(overview.estimatedCost)}`}
            </span>
          }
          hint={
            <span className="ov-cost-hint">
              <span>{t('sec.usage.overview.hint.cost', { priced: compactNumber(overview.pricedRequests), total: compactNumber(overview.totalRequests) })}</span>
              {unpriced > 0 ? (
                <a className="ov-link" href={`#${routePath('usage', 'prices')}`}>{t('sec.usage.overview.cost.unpriced', { count: compactNumber(unpriced) })}</a>
              ) : null}
            </span>
          }
        />
      </div>
      <TrendCard series={series} />
      <div className="ov-pair">
        <ProvidersCard providers={analysis.providers} />
        <ModelsCard models={analysis.models} />
      </div>
      <BreakdownCard overview={overview} />
    </>
  );
}

function TrendCard({ series }: { series: ReturnType<typeof buildUsageTrendSeries> }) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<TrendMode>('tokens');
  // Short labels: the kit chart spaces x labels for ~72px, so sub-day buckets show the time only.
  const xLabels = series.points.map((p) => formatTrendAxisLabel(p, series.bucket, locale, { compactSameDay: true }));

  const chart = useMemo(() => {
    if (mode === 'requests') {
      return [
        { id: 'success', label: t('sec.usage.overview.trend.success'), color: 'var(--ec-ok)', values: series.points.map((p) => p.success) },
        { id: 'failure', label: t('sec.usage.overview.trend.failed'), color: 'var(--ec-danger)', values: series.points.map((p) => p.failure) },
        { id: 'canceled', label: t('sec.usage.overview.trend.canceled'), color: 'var(--ec-fg-subtle)', values: series.points.map((p) => p.canceled) },
      ];
    }
    const ranked = new Set(series.models.filter((m) => m.key !== OTHER_TREND_MODEL_KEY).map((m) => m.key));
    return series.models.map((model, index) => {
      const isOther = model.key === OTHER_TREND_MODEL_KEY;
      const label = isOther ? t('sec.usage.overview.trend.other') : model.key === 'unknown' ? t('sec.usage.overview.trend.unknown') : model.label;
      return {
        id: model.key,
        label,
        color: isOther ? 'var(--ec-fg-subtle)' : MODEL_COLORS[index % MODEL_COLORS.length],
        values: series.points.map((p) => isOther
          ? Object.entries(p.models).reduce((sum, [key, value]) => (ranked.has(key) ? sum : sum + value), 0)
          : p.models[model.key] ?? 0),
      };
    });
  }, [mode, series, t]);

  return (
    <Card as="section">
      <CardHeader
        title={t('sec.usage.overview.trend.title')}
        actions={
          <span className="ov-modes">
            <SegmentedControl<TrendMode>
              size="sm"
              ariaLabel={t('sec.usage.overview.trend.mode')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'tokens', label: t('sec.usage.overview.trend.tokens') },
                { value: 'requests', label: t('sec.usage.overview.trend.requests') },
              ]}
            />
            <button type="button" className="ov-mode-off" disabled aria-disabled="true" title={t('sec.usage.overview.trend.costDisabled')}>
              <Ban size={12} aria-hidden="true" />
              {t('sec.usage.overview.trend.cost')}
            </button>
          </span>
        }
      />
      {series.points.length === 0 ? (
        <EmptyState compact title={t('sec.usage.overview.list.empty')} />
      ) : (
        <>
          <AreaChart
            series={chart}
            xLabels={xLabels}
            stacked
            height={220}
            yFormat={compactNumber}
            tooltipFormat={(value) => compactNumber(value)}
            ariaLabel={t('sec.usage.overview.trend.aria')}
          />
          <ChartLegend items={chart.map((s) => ({ label: s.label, color: s.color }))} />
        </>
      )}
    </Card>
  );
}

function MetricToggle({ value, onChange }: { value: Metric; onChange: (v: Metric) => void }) {
  const { t } = useI18n();
  return (
    <SegmentedControl<Metric>
      size="sm"
      ariaLabel={t('sec.usage.overview.metric.label')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'tokens', label: t('sec.usage.overview.metric.tokens') },
        { value: 'requests', label: t('sec.usage.overview.metric.requests') },
      ]}
    />
  );
}

const valueLabel = (value: number, total: number) => `${compactNumber(value)} · ${total > 0 ? Math.round((value / total) * 100) : 0}%`;

function ProvidersCard({ providers }: { providers: UsageCategory[] }) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<Metric>('tokens');
  const rows = rank(providers, metric).filter((p) => p[metric] > 0);
  const total = rows.reduce((sum, p) => sum + p[metric], 0);
  return (
    <Card as="section">
      <CardHeader title={t('sec.usage.overview.providers.title')} actions={<MetricToggle value={metric} onChange={setMetric} />} />
      {rows.length === 0 ? <EmptyState compact title={t('sec.usage.overview.list.empty')} /> : (
        <HBar
          ariaLabel={t('sec.usage.overview.providers.aria')}
          rows={rows.map((p) => {
            const info = providerInfo(p.key || p.label);
            return {
              id: p.key,
              label: <span className="ov-prov"><ProviderLogo provider={info.id === 'other' ? p.label : info.id} size={16} /><span className="ov-trunc">{info.name}</span></span>,
              value: p[metric],
              color: info.colorVar,
              valueLabel: valueLabel(p[metric], total),
              onClick: () => navigate(routePath('usage', 'requests', { provider: p.key })),
            };
          })}
        />
      )}
    </Card>
  );
}

function ModelsCard({ models }: { models: UsageCategory[] }) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<Metric>('tokens');
  const all = rank(models, metric).filter((m) => m[metric] > 0);
  const total = all.reduce((sum, m) => sum + m[metric], 0);
  const rows = all.slice(0, TOP_MODELS);
  return (
    <Card as="section">
      <CardHeader title={t('sec.usage.overview.models.title')} actions={<MetricToggle value={metric} onChange={setMetric} />} />
      {rows.length === 0 ? <EmptyState compact title={t('sec.usage.overview.list.empty')} /> : (
        <HBar
          ariaLabel={t('sec.usage.overview.models.aria')}
          rows={rows.map((m, i) => ({
            id: m.key,
            label: <span className="ov-trunc" title={m.label}>{m.label}</span>,
            value: m[metric],
            color: MODEL_COLORS[i % MODEL_COLORS.length],
            valueLabel: valueLabel(m[metric], total),
          }))}
        />
      )}
    </Card>
  );
}

function BreakdownCard({ overview }: { overview: UsageOverview }) {
  const { t, locale } = useI18n();
  const parts = [
    { id: 'input', label: t('sec.usage.overview.breakdown.input'), value: overview.inputTokens, color: 'var(--ec-s1)' },
    { id: 'output', label: t('sec.usage.overview.breakdown.output'), value: overview.outputTokens, color: 'var(--ec-s2)' },
    { id: 'reasoning', label: t('sec.usage.overview.breakdown.reasoning'), value: overview.reasoningTokens, color: 'var(--ec-s3)' },
    { id: 'cacheRead', label: t('sec.usage.overview.breakdown.cacheRead'), value: overview.cacheReadTokens, color: 'var(--ec-s4)' },
    { id: 'cacheCreation', label: t('sec.usage.overview.breakdown.cacheCreation'), value: overview.cacheCreationTokens, color: 'var(--ec-s5)' },
  ].map((p) => ({ ...p, value: Number.isFinite(p.value) ? Math.max(0, p.value) : 0 }));
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <Card as="section">
      <CardHeader title={t('sec.usage.overview.breakdown.title')} />
      <div className="ov-bar" role="img" aria-label={t('sec.usage.overview.breakdown.aria')}>
        {total > 0 ? parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.id} className="ov-bar-seg" style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${compactNumber(p.value)}`} />
        )) : null}
      </div>
      <ul className="ov-bar-legend">
        {parts.map((p) => (
          <li key={p.id} className="ov-bar-item">
            <span className="ov-bar-swatch" style={{ background: p.color }} aria-hidden="true" />
            <span className="ov-bar-name">{p.label}</span>
            <span className="ov-bar-num ec-num">{compactNumber(p.value)}</span>
            <span className="ov-bar-pct ec-muted ec-num">{formatPercent(total > 0 ? (p.value / total) * 100 : 0, 1, locale)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
