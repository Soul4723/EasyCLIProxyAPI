import { useState, type ReactNode } from 'react';
import { Filter, Gauge } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { routeHref } from '../../shell/router';
import { calculateTokenComposition, formatGenerationSpeed } from '../../services/usageMetrics';
import { usageModelDetails } from '../../services/usageModel';
import { usageProviderDetails } from '../../services/usageProvider';
import { Button, Chip, CopyButton, Masked, ProviderLogo, ProviderName, SidePanel } from '../../ui';
import { compactDuration } from './format';
import { OutcomePill, costLabel, isFast, outcomeOf, useAgentLabel } from './RequestsCells';
import type { UsageRecord } from './types';

const ERROR_COLLAPSE_LINES = 8;

const prettyBody = (body: string) => {
  const text = body.trim();
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="req-section">
      <h3 className="req-section__title">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="req-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ErrorBlock({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [expanded, setExpanded] = useState(false);
  const body = prettyBody(record.failure_body);
  const lines = body ? body.split('\n').length : 0;
  const collapsed = lines > ERROR_COLLAPSE_LINES && !expanded;
  const raw = [record.failure_status > 0 ? `HTTP ${record.failure_status}` : '', record.failure_body.trim()].filter(Boolean).join(' · ');
  return (
    <Section title={t('sec.usage.requests.section.error')}>
      <div className="req-error">
        <div className="req-error__head">
          {record.failure_status > 0 ? <Chip tone="danger" size="sm">{t('sec.usage.requests.error.http', { status: record.failure_status })}</Chip> : null}
          <CopyButton value={raw} size="sm" />
        </div>
        {body ? <pre className={`req-code${collapsed ? ' is-collapsed' : ''}`}>{mask.text(body)}</pre> : null}
        {lines > ERROR_COLLAPSE_LINES ? (
          <Button variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? t('sec.usage.requests.error.collapse') : t('sec.usage.requests.error.expand', { count: lines })}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

const TOKEN_COLORS = { input: 'var(--ec-s4)', 'cache-read': 'var(--ec-s3)', 'cache-creation': 'var(--ec-s5)', output: 'var(--ec-s1)' } as const;

function TokensSection({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const tk = record.tokens;
  const comp = calculateTokenComposition({
    inputTokens: tk.input_tokens, outputTokens: tk.output_tokens, cacheReadTokens: tk.cache_read_tokens, cacheCreationTokens: tk.cache_creation_tokens,
  });
  const labels = {
    input: t('sec.usage.requests.tokens.uncached'), 'cache-read': t('sec.usage.requests.tokens.cacheRead'),
    'cache-creation': t('sec.usage.requests.tokens.cacheWrite'), output: t('sec.usage.requests.tokens.output'),
  } as const;
  return (
    <Section title={t('sec.usage.requests.section.tokens')}>
      <div className="req-tokens-total"><strong className="ec-num">{tk.total_tokens.toLocaleString()}</strong><span className="ec-muted">{t('sec.usage.requests.tokens.total')}</span></div>
      <div className="req-stackbar" role="img" aria-label={t('sec.usage.requests.section.tokens')}>
        {comp.segments.filter((s) => s.percent > 0).map((s) => (
          <span key={s.key} style={{ width: `${s.percent}%`, background: TOKEN_COLORS[s.key] }} title={`${labels[s.key]}: ${Math.round(s.value).toLocaleString()}`} />
        ))}
      </div>
      <dl className="req-kvs">
        {comp.segments.map((s) => (
          <div className="req-kv" key={s.key}>
            <dt><i className="req-dot" style={{ background: TOKEN_COLORS[s.key] }} />{labels[s.key]}</dt>
            <dd className="ec-num">{Math.round(s.value).toLocaleString()}<span className="ec-muted"> {s.percent.toFixed(0)}%</span></dd>
          </div>
        ))}
        {tk.reasoning_tokens > 0 ? <Row label={t('sec.usage.requests.tokens.reasoning')}><span className="ec-num">{tk.reasoning_tokens.toLocaleString()}</span></Row> : null}
      </dl>
    </Section>
  );
}

function TimingSection({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const speed = formatGenerationSpeed({ outputTokens: record.tokens.output_tokens, latencyMs: record.latency_ms });
  const ttftPct = record.ttft_ms != null && record.latency_ms > 0 ? Math.min(100, (record.ttft_ms / record.latency_ms) * 100) : 0;
  return (
    <Section title={t('sec.usage.requests.section.timing')}>
      <div className="req-timeline" role="img" aria-label={t('sec.usage.requests.section.timing')}>
        {record.ttft_ms != null ? <span className="req-timeline__ttft" style={{ width: `${ttftPct}%` }} /> : null}
        <span className="req-timeline__rest" />
      </div>
      <dl className="req-kvs">
        <Row label={t('sec.usage.requests.timing.total')}><span className="ec-num">{compactDuration(record.latency_ms)}</span></Row>
        <Row label={t('sec.usage.requests.timing.ttft')}><span className="ec-num">{record.ttft_ms == null ? '—' : compactDuration(record.ttft_ms)}</span></Row>
        <Row label={t('sec.usage.requests.timing.speed')}><span className="ec-num">{speed}</span></Row>
      </dl>
    </Section>
  );
}

export function RequestDrawer({ record, onClose, onFilterAccount }: {
  record: UsageRecord | null;
  onClose: () => void;
  onFilterAccount: (authIndex: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const agentLabel = useAgentLabel();
  const open = record !== null;
  if (!record) return <SidePanel open={false} onClose={onClose} title="" ariaLabel={t('sec.usage.requests.drawer.label')}>{null}</SidePanel>;

  const model = usageModelDetails(record.model, record.alias, record.response_model);
  const provider = usageProviderDetails(record.provider, record.auth_type);
  const failed = outcomeOf(record) !== 'success';
  const pathText = record.endpoint.trim();
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      width={520}
      ariaLabel={t('sec.usage.requests.drawer.label')}
      title={<span className="ec-sec-usage req-drawer-title"><ProviderLogo provider={record.provider} size={24} /><span className="ec-trunc">{model.requested}</span><OutcomePill record={record} /></span>}
      subtitle={formatDate(record.timestamp, { dateStyle: 'medium', timeStyle: 'medium' })}
      footer={record.source ? (
        <div className="ec-sec-usage req-drawer-footer">
          <a className="req-link" href={routeHref('quota', null, { cred: record.source })} onClick={onClose}><Gauge size={14} aria-hidden="true" />{t('sec.usage.requests.link.quota')} →</a>
          <Button variant="outline" size="sm" icon={<Filter size={14} />} onClick={() => { onFilterAccount(record.source); onClose(); }}>{t('sec.usage.requests.link.filter')}</Button>
        </div>
      ) : undefined}
    >
      <div className="ec-sec-usage req-drawer">
        {failed ? <ErrorBlock record={record} /> : null}
        <Section title={t('sec.usage.requests.section.request')}>
          <dl className="req-kvs">
            <Row label={t('sec.usage.requests.field.time')}><span className="ec-num">{formatDate(record.timestamp, { dateStyle: 'medium', timeStyle: 'medium' })}</span></Row>
            <Row label={t('sec.usage.requests.field.id')}><span className="req-id"><Masked kind="identifier" mono className="ec-trunc" value={record.id} /><CopyButton value={record.id} size="sm" /></span></Row>
            <Row label={t('sec.usage.requests.field.endpoint')}><span className="ec-mono ec-trunc" title={pathText}>{pathText || '—'}</span></Row>
            <Row label={t('sec.usage.requests.field.agent')}>{agentLabel(record.agent)}</Row>
            <Row label={t('sec.usage.requests.field.key')}>
              <span className="req-stack req-stack--end">
                <Masked kind="identifier" mono value={record.api_key_display || '—'} />
                <small className="ec-muted"><Masked value={record.api_key_remark || t('sec.usage.requests.field.noRemark')} /></small>
              </span>
            </Row>
            <Row label={t('sec.usage.requests.field.authType')}>{provider.access || provider.rawAuthType || '—'}</Row>
          </dl>
        </Section>
        <Section title={t('sec.usage.requests.section.route')}>
          <dl className="req-kvs">
            <Row label={t('sec.usage.requests.field.provider')}><span className="req-prov"><ProviderLogo provider={record.provider} size={16} /><ProviderName provider={record.provider} /></span></Row>
            <Row label={t('sec.usage.requests.field.account')}><Masked className="ec-trunc" value={record.source_display || record.source || '—'} /></Row>
            <Row label={t('sec.usage.requests.field.requestedModel')}><span className="ec-mono ec-trunc">{model.requested}</span></Row>
            {model.showResolved ? <Row label={t('sec.usage.requests.field.routedModel')}><span className="ec-mono ec-trunc">{model.resolved}</span></Row> : null}
            {model.response ? (
              <Row label={t('sec.usage.requests.field.responseModel')}>
                <span className="req-prov"><span className="ec-mono ec-trunc">{model.response}</span>{model.mismatch ? <Chip tone="warn" size="sm">{t('sec.usage.requests.mismatch')}</Chip> : null}</span>
              </Row>
            ) : null}
            <Row label={t('sec.usage.requests.field.effort')}><Chip size="sm">{record.reasoning_effort || 'auto'}</Chip></Row>
            {record.service_tier ? <Row label={t('sec.usage.requests.field.tier')}><Chip size="sm" tone={isFast(record) ? 'accent' : 'neutral'}>{record.service_tier}</Chip></Row> : null}
          </dl>
        </Section>
        <TokensSection record={record} />
        <TimingSection record={record} />
        <Section title={t('sec.usage.requests.section.cost')}>
          <dl className="req-kvs">
            <Row label={t('sec.usage.requests.cost.amount')}><strong className="ec-num" title={record.cost ? t('sec.usage.requests.costHint', { model: record.cost.pricing_model }) : t('sec.usage.requests.unpriced')}>{record.cost ? costLabel(record) : t('sec.usage.requests.unpriced')}</strong></Row>
            {record.cost ? <Row label={t('sec.usage.requests.cost.pricing')}><span className="ec-mono ec-trunc">{record.cost.pricing_model}</span></Row> : null}
          </dl>
        </Section>
      </div>
    </SidePanel>
  );
}
