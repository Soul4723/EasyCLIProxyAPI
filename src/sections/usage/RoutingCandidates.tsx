import { ArrowUpRight, Plus, Users } from 'lucide-react';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import {
  Card, CardHeader, Countdown, EmptyState, ErrorState, Masked, ProviderLogo, ProviderName, Skeleton, StatusPill, providerInfo,
} from '../../ui';
import type { Block, Candidate, CandidateGroup } from './RoutingData';

type Props = {
  block: Block<unknown>;
  groups: CandidateGroup[];
  served: Map<string, number>;
  onCooldownDone: () => void;
};

function CandidateRow({ item, served, max, onCooldownDone }: { item: Candidate; served: number; max: number; onCooldownDone: () => void }) {
  const { t } = useI18n();
  const color = providerInfo(item.provider).colorVar;
  return (
    <li className="rt-cand" data-status={item.status}>
      <span className="rt-cand__rank ec-mono" title={t('sec.usage.routing.candidates.rank', { n: item.rank })}>{item.rank}</span>
      <span className="rt-cand__who">
        <Masked value={item.label} kind={item.labelIsFile ? 'identifier' : 'text'} identities={item.identities} />
        <span className="rt-cand__prio ec-muted ec-num">{t('sec.usage.routing.candidates.priority', { n: item.priority })}</span>
      </span>
      <span className="rt-cand__status">
        <StatusPill status={item.status} size="sm" />
        {item.status === 'cooldown' && item.cooldownUntil ? (
          <Countdown to={item.cooldownUntil} compact onDone={onCooldownDone} className="rt-cand__cd" />
        ) : null}
      </span>
      <span className="rt-cand__served" title={t('sec.usage.routing.candidates.served', { n: served })}>
        <span className="rt-cand__track" aria-hidden="true">
          <span className="rt-cand__fill" style={{ width: `${max > 0 ? (served / max) * 100 : 0}%`, background: color }} />
        </span>
        <span className="ec-num ec-muted">{served}</span>
      </span>
      {item.authIndex ? (
        <span className="rt-cand__links">
          <a className="rt-link" href={routeHref('usage', 'requests', { account: item.authIndex })}>
            {t('sec.usage.routing.candidates.requests')}<ArrowUpRight size={12} aria-hidden="true" />
          </a>
          <a className="rt-link" href={routeHref('quota', null, { cred: item.authIndex })}>
            {t('sec.usage.routing.candidates.credential')}<ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </span>
      ) : null}
    </li>
  );
}

/** B: candidates per provider in routing order, with recent served counts and link-only actions. */
export function RoutingCandidates({ block, groups, served, onCooldownDone }: Props) {
  const { t } = useI18n();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const max = Math.max(0, ...served.values());
  const showError = block.error && block.data === null;
  return (
    <Card as="section" className="rt-card rt-candidates" aria-label={t('sec.usage.routing.candidates.title')}>
      <CardHeader title={t('sec.usage.routing.candidates.title')} count={total} icon={<Users size={16} />} />
      {block.loading && block.data === null ? <Skeleton lines={5} height={28} /> : null}
      {showError ? <ErrorState title={t('sec.usage.routing.candidates.error')} onRetry={block.reload} /> : null}
      {block.data !== null && total === 0 ? (
        <EmptyState
          compact
          icon={<Users size={20} />}
          title={t('sec.usage.routing.candidates.empty')}
          action={<a className="rt-link" href={routeHref('providers')}><Plus size={13} aria-hidden="true" />{t('sec.usage.routing.candidates.add')}</a>}
        />
      ) : null}
      {total > 0 ? (
        <div className="rt-scroll">
          {groups.map((group) => (
            <section key={group.provider} className="rt-group" aria-label={t('sec.usage.routing.candidates.group', { provider: providerInfo(group.provider).name, count: group.items.length })}>
              <header className="rt-group__head">
                <ProviderLogo provider={group.provider} size={20} />
                <ProviderName provider={group.provider} />
                <span className="rt-group__count ec-num">{group.items.length}</span>
              </header>
              <ul className="rt-cands">
                {group.items.map((item) => (
                  <CandidateRow key={item.key} item={item} served={item.authIndex ? served.get(item.authIndex) ?? 0 : 0} max={max} onCooldownDone={onCooldownDone} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
