import type { ReactNode } from 'react';
import { ArrowUpRight, Gauge, Layers, Link2, Repeat, Route, Snowflake, Timer } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { settingFieldRoute } from '../../services/settingsNavigation';
import { Card, CardHeader, Chip, Skeleton, ErrorState, type ChipTone } from '../../ui';
import type { Block, RoutingPolicy as Policy } from './RoutingData';

const STRATEGY_KEYS: Record<string, MessageKey> = {
  'round-robin': 'sec.usage.routing.policy.strategy.round-robin',
  'fill-first': 'sec.usage.routing.policy.strategy.fill-first',
};

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rt-fact">
      <span className="rt-fact__icon" aria-hidden="true">{icon}</span>
      <span className="rt-fact__label">{label}</span>
      <span className="rt-fact__value">{children}</span>
    </div>
  );
}

/** A: current routing policy as chips, read-only; editing lives in Settings → Routing. */
export function RoutingPolicy({ block }: { block: Block<Policy> }) {
  const { t } = useI18n();
  const policy = block.data;
  const onOff = (on: boolean, tone: ChipTone = 'ok') => (
    <Chip tone={on ? tone : 'neutral'} size="sm">{t(on ? 'sec.usage.routing.policy.on' : 'sec.usage.routing.policy.off')}</Chip>
  );
  const edit = (
    <a className="rt-link" href={`#${settingFieldRoute('routing.strategy')}`}>
      {t('sec.usage.routing.policy.edit')}<ArrowUpRight size={13} aria-hidden="true" />
    </a>
  );
  return (
    <Card as="section" className="rt-policy" aria-label={t('sec.usage.routing.policy.title')}>
      <CardHeader title={t('sec.usage.routing.policy.title')} icon={<Route size={16} />} actions={edit} />
      {block.loading && !policy ? <Skeleton height={28} /> : null}
      {block.error ? <ErrorState title={t('sec.usage.routing.policy.error')} onRetry={block.reload} /> : null}
      {policy ? (
        <div className="rt-facts">
          <Fact icon={<Layers size={14} />} label={t('sec.usage.routing.policy.strategy')}>
            <Chip tone="accent" size="sm">{STRATEGY_KEYS[policy.routingStrategy] ? t(STRATEGY_KEYS[policy.routingStrategy]) : policy.routingStrategy || '—'}</Chip>
          </Fact>
          <Fact icon={<Link2 size={14} />} label={t('sec.usage.routing.policy.affinity')}>
            {onOff(policy.routingSessionAffinity)}
            {policy.routingSessionAffinity && policy.routingSessionAffinityTtl
              ? <span className="rt-fact__sub ec-mono" title={t('sec.usage.routing.policy.affinityTtl')}>{policy.routingSessionAffinityTtl}</span> : null}
          </Fact>
          <Fact icon={<Repeat size={14} />} label={t('sec.usage.routing.policy.retry')}>
            <span className="ec-num">{policy.requestRetry}</span>
          </Fact>
          <Fact icon={<Gauge size={14} />} label={t('sec.usage.routing.policy.maxCreds')}>
            <span className="ec-num">{policy.maxRetryCredentials > 0 ? policy.maxRetryCredentials : t('sec.usage.routing.policy.all')}</span>
          </Fact>
          <Fact icon={<Timer size={14} />} label={t('sec.usage.routing.policy.interval')}>
            <span className="ec-num">{t('sec.usage.routing.policy.seconds', { n: policy.maxRetryInterval })}</span>
          </Fact>
          <Fact icon={<Snowflake size={14} />} label={t('sec.usage.routing.policy.cooling')}>
            <Chip tone={policy.disableCooling ? 'warn' : 'ok'} size="sm">
              {t(policy.disableCooling ? 'sec.usage.routing.policy.coolingOff' : 'sec.usage.routing.policy.coolingOn')}
            </Chip>
          </Fact>
        </div>
      ) : null}
    </Card>
  );
}
