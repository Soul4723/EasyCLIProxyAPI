import { ArrowDown, ArrowUp, Database } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatCacheReadRate, formatGenerationSpeed } from '../../services/usageMetrics';
import { usageModelDetails } from '../../services/usageModel';
import { usageProviderDetails } from '../../services/usageProvider';
import { Chip, Masked, ProviderLogo, StatusPill } from '../../ui';
import { compactDuration, compactNumber, formatUsd } from './format';
import type { UsageRecord } from './types';

export type Outcome = 'success' | 'failed' | 'canceled';

export const outcomeOf = (record: UsageRecord): Outcome => (record.canceled ? 'canceled' : record.failed ? 'failed' : 'success');

/** Display names for the agents the collector recognises; anything else is data and shown as-is. */
export function useAgentLabel() {
  const { t } = useI18n();
  return (agent: string | undefined) => {
    switch (agent) {
      case 'codex': return 'Codex';
      case 'claude-code': return 'Claude Code';
      case 'gemini-cli': return 'Gemini CLI';
      case undefined: case '': case 'unknown': return t('sec.usage.agent.unknown');
      default: return agent;
    }
  };
}

export const isFast = (record: UsageRecord) => ['priority', 'fast'].includes(record.service_tier?.trim().toLowerCase() ?? '');

export const costLabel = (record: UsageRecord) => (record.cost ? `~${formatUsd(record.cost.total)}` : '—');

/** Success / Failed (+HTTP status) / Canceled in the shared status colours. */
export function OutcomePill({ record, size = 'sm' }: { record: UsageRecord; size?: 'sm' | 'md' }) {
  const { t } = useI18n();
  const outcome = outcomeOf(record);
  if (outcome === 'failed') {
    const status = record.failure_status > 0 ? ` ${record.failure_status}` : '';
    return <StatusPill status="error" size={size} label={`${t('sec.usage.result.failed')}${status}`} />;
  }
  return outcome === 'canceled'
    ? <StatusPill status="disabled" size={size} label={t('sec.usage.result.canceled')} />
    : <StatusPill status="available" size={size} label={t('sec.usage.result.success')} />;
}

export function ModelCell({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const model = usageModelDetails(record.model, record.alias, record.response_model);
  const effort = record.reasoning_effort || 'auto';
  const title = [
    `${t('sec.usage.requests.field.requestedModel')}: ${model.requested}`,
    model.showResolved ? `${t('sec.usage.requests.field.routedModel')}: ${model.resolved}` : '',
    model.showResponseInTooltip ? `${t('sec.usage.requests.field.responseModel')}: ${model.response}` : '',
    model.mismatch ? t('sec.usage.requests.mismatch') : '',
  ].filter(Boolean).join('\n');
  return (
    <div className="req-model" title={title}>
      <ProviderLogo provider={record.provider} size={22} />
      <div className="req-stack">
        <span className="req-line">
          <strong className="ec-trunc">{model.requested}</strong>
          <span className="req-chip"><Chip size="sm">{effort}</Chip></span>
          {isFast(record) ? <span className="req-chip"><Chip size="sm" tone="accent">{t('sec.usage.requests.fast')}</Chip></span> : null}
          {model.mismatch ? <span className="req-chip"><Chip size="sm" tone="warn">≠</Chip></span> : null}
        </span>
        {model.showResolved ? <small className="ec-trunc ec-muted ec-mono">{model.resolved}</small> : null}
      </div>
    </div>
  );
}

export function AccountCell({ record }: { record: UsageRecord }) {
  const provider = usageProviderDetails(record.provider, record.auth_type);
  return (
    <div className="req-stack req-account">
      <Masked className="ec-trunc" value={record.source_display || record.provider || '—'} />
      <small className="ec-muted ec-trunc">{provider.name}{provider.access ? ` · ${provider.access}` : ''}</small>
    </div>
  );
}

export function TokensCell({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const tk = record.tokens;
  const cache = formatCacheReadRate({ inputTokens: tk.input_tokens, cacheReadTokens: tk.cache_read_tokens });
  const title = [
    `${tk.total_tokens.toLocaleString()}`,
    `${t('sec.usage.requests.in')}: ${tk.input_tokens.toLocaleString()}`,
    `${t('sec.usage.requests.out')}: ${tk.output_tokens.toLocaleString()}`,
    `${t('sec.usage.requests.cache')}: ${tk.cache_read_tokens.toLocaleString()} (${cache})`,
  ].join('\n');
  return (
    <div className="req-stack" title={title}>
      <strong className="ec-num">{compactNumber(tk.total_tokens)}</strong>
      <small className="req-metrics ec-muted">
        <span className="req-in"><ArrowUp size={10} aria-hidden="true" />{compactNumber(tk.input_tokens)}</span>
        <span className="req-out"><ArrowDown size={10} aria-hidden="true" />{compactNumber(tk.output_tokens)}</span>
        {tk.cache_read_tokens > 0 ? <span className="req-cache"><Database size={10} aria-hidden="true" />{cache}</span> : null}
      </small>
    </div>
  );
}

const durationTone = (ms: number | null) => (ms == null || ms < 0 ? '' : ms >= 30_000 ? 'is-bad' : ms >= 15_000 ? 'is-warn' : '');

export function LatencyCell({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const speed = formatGenerationSpeed({ outputTokens: record.tokens.output_tokens, latencyMs: record.latency_ms });
  const title = `${t('sec.usage.requests.timing.total')}: ${record.latency_ms} ms\n${t('sec.usage.requests.timing.ttft')}: ${record.ttft_ms == null ? '—' : `${record.ttft_ms} ms`}`;
  return (
    <div className="req-stack" title={title}>
      <strong className={`ec-num req-dur ${durationTone(record.latency_ms)}`}>{compactDuration(record.latency_ms)}</strong>
      <small className="ec-muted ec-num">{record.ttft_ms == null ? '—' : `${t('sec.usage.requests.ttft')} ${compactDuration(record.ttft_ms)}`}{speed === '—' ? '' : ` · ${speed}`}</small>
    </div>
  );
}

export function CostCell({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const title = record.cost ? t('sec.usage.requests.costHint', { model: record.cost.pricing_model }) : t('sec.usage.requests.unpriced');
  return <strong className={`ec-num${record.cost ? '' : ' ec-muted'}`} title={title}>{costLabel(record)}</strong>;
}
