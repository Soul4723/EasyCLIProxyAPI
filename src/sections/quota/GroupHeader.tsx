// Provider summary strip (CPAMC/C5): logo, name, aggregate % left, one bar segment per account, on/total, next reset.
import { ChevronDown } from 'lucide-react';
import { Badge, Chip, ProviderLogo, ProviderName, STATUS_ORDER, statusColor } from '../../ui';
import { useUiText } from '../../ui/uiText';
import { useI18n } from '../../i18n';
import { providerInfo } from '../../ui';
import { usePrivacyMask } from '../../privacy';
import type { ProviderGroup, QuotaAccount } from './model';
import { NEEDS_ATTENTION } from './model';
import { ResetTime } from './WindowMeter';

function segmentTone(account: QuotaAccount): string {
  const pct = account.effectiveLeftPct;
  if (pct === null || account.disabled) return '';
  return pct >= 50 ? 'ok' : pct >= 20 ? 'warn' : 'danger';
}

export function SegmentedBar({ accounts, onPick }: { accounts: QuotaAccount[]; onPick: (account: QuotaAccount) => void }) {
  const { t, formatNumber } = useI18n();
  const privacy = usePrivacyMask();
  return (
    <div className="qt-seg" role="group" aria-label={t('sec.quota.segments')}>
      {accounts.map((account) => {
        const tone = segmentTone(account);
        const pct = account.effectiveLeftPct;
        const title = `${privacy.text(account.label, account.identities)} · ${pct === null ? t('sec.quota.notFetched') : `${formatNumber(Math.round(pct))}%`}`;
        return (
          <button
            key={account.key}
            type="button"
            className={`qt-seg__cell${tone ? '' : ' qt-seg__cell--empty'}${account.stale ? ' qt-stale' : ''}`}
            title={title}
            aria-label={title}
            onClick={() => onPick(account)}
          >
            {tone ? <span className={`qt-seg__fill qt-seg__fill--${tone}`} style={{ width: `${Math.max(3, pct ?? 0)}%` }} /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function GroupHeader({
  group, now, collapsed, onToggle, onPick,
}: {
  group: ProviderGroup; now: number; collapsed: boolean; onToggle: () => void; onPick: (account: QuotaAccount) => void;
}) {
  const { t, formatNumber } = useI18n();
  const tu = useUiText();
  const info = providerInfo(group.provider);
  const flagged = STATUS_ORDER.filter((status) => status !== 'available' && (group.counts[status] ?? 0) > 0);
  return (
    <div className="qt-group__head" style={{ '--qt-pc': `var(${info.colorVar.replace(/^var\(|\)$/g, '')})` } as React.CSSProperties}>
      <button type="button" className="qt-group__title" aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronDown size={14} className={collapsed ? 'qt-chev qt-chev--closed' : 'qt-chev'} aria-hidden="true" />
        <ProviderLogo provider={group.provider} size={22} />
        <h2>{group.provider === 'plugin' ? t('quota.pluginCategory') : <ProviderName provider={group.provider} />}</h2>
        <Badge count={group.total} />
      </button>
      <div className="qt-group__pct" title={t('sec.quota.leftAggregate')}>
        {group.leftPct === null ? <span className="qt-group__big ec-muted">—</span> : <span className="qt-group__big ec-num">{formatNumber(Math.round(group.leftPct))}<small>%</small></span>}
        <span className="qt-group__unit">{t('sec.quota.left')}</span>
      </div>
      <SegmentedBar accounts={group.accounts} onPick={onPick} />
      <div className="qt-group__meta">
        <Chip size="sm" tone={group.enabled === group.total ? 'ok' : 'neutral'}>{t('sec.quota.onCount', { on: group.enabled, total: group.total })}</Chip>
        {flagged.map((status) => (
          <span key={status} className="qt-dotcount" title={tu(`ui.status.${status}` as never)} style={{ color: `var(${statusColor(status).replace(/^var\(|\)$/g, '')})` }}>
            <i style={{ background: 'currentColor' }} />{group.counts[status]}
            {NEEDS_ATTENTION.includes(status) ? null : null}
          </span>
        ))}
        {group.nextResetMs ? <span className="qt-group__next ec-muted">{t('sec.quota.nextReset')} <ResetTime ms={group.nextResetMs} now={now} passed={false} /></span> : null}
      </div>
    </div>
  );
}
