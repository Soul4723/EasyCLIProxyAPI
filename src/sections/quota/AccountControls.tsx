// Per-account controls shared by the card, the compact row and the detail panel:
// banked-reset badge (↻n), lighting button (⚡), refresh, enable toggle.
import { RefreshCw, RotateCcw, Zap } from 'lucide-react';
import { Countdown, IconButton, Toggle } from '../../ui';
import { useI18n } from '../../i18n';
import { canResetQuota } from '../../services/quotaActions';
import type { QuotaAccount } from './model';
import { lightingStateOf, type LightingApi } from './useLighting';

export type QuotaActions = {
  open: (account: QuotaAccount) => void;
  refresh: (account: QuotaAccount) => void;
  setEnabled: (account: QuotaAccount, enabled: boolean) => void;
  consume: (account: QuotaAccount) => void;
  clearCooldown: (account: QuotaAccount) => void;
  openLighting: (account: QuotaAccount, anchor: HTMLElement) => void;
};

export type ControlsContext = {
  now: number;
  lighting: LightingApi;
  actions: QuotaActions;
  busyKeys: ReadonlySet<string>;
};

export function BankedBadge({ account, ctx, size = 'sm' }: { account: QuotaAccount; ctx: ControlsContext; size?: 'sm' | 'md' }) {
  const { t, formatNumber } = useI18n();
  const banked = account.banked;
  if (!banked) return null;
  const usable = canResetQuota(account.file, account.quota) && !account.disabled;
  const retry = banked.pendingClaude;
  const title = [
    retry ? t('quota.claude.retry') : t('sec.quota.banked.title', { count: banked.count }),
    banked.soonestExpiryMs ? t('sec.quota.banked.expires', { time: new Date(banked.soonestExpiryMs).toLocaleString() }) : '',
    usable ? t('sec.quota.banked.use') : t('sec.quota.banked.unavailable'),
  ].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`qt-banked qt-banked--${size}${banked.useSoon || retry ? ' qt-banked--soon' : ''}`}
      title={title}
      aria-label={title}
      disabled={!usable}
      onClick={() => ctx.actions.consume(account)}
    >
      <RotateCcw size={12} aria-hidden="true" />
      <span className="ec-num">{retry ? t('sec.quota.banked.retry') : formatNumber(banked.count)}</span>
      {banked.useSoon && banked.soonestExpiryMs ? <span className="qt-banked__soon"><Countdown to={banked.soonestExpiryMs} compact /></span> : null}
    </button>
  );
}

export function LightningButton({ account, ctx, size = 'sm' }: { account: QuotaAccount; ctx: ControlsContext; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useI18n();
  const { lighting } = ctx;
  const capability = lighting.capabilityFor(account.provider);
  const schedule = lighting.scheduleFor(account);
  const state = lightingStateOf(schedule, lighting.status?.runningIds ?? [], ctx.now);
  const lit = state !== 'off';
  let reason = '';
  if (!lighting.available) reason = t('sec.quota.lighting.unavailable');
  else if (capability && !capability.supported) reason = t('sec.quota.lighting.unsupported');
  else if (!account.authIndex) reason = t('sec.quota.lighting.noIndex');
  const label = reason || (lit ? t(`sec.quota.lighting.state.${state}` as never) : t('sec.quota.lighting.open'));
  return (
    <span className={`qt-light${lit ? ' qt-light--lit' : ''}${state === 'failed' || state === 'paused' ? ' qt-light--warn' : ''}`}>
      <IconButton
        label={label}
        size={size}
        variant="ghost"
        icon={<Zap size={14} fill={lit ? 'currentColor' : 'none'} />}
        disabled={Boolean(reason)}
        active={lit}
        onClick={(event) => ctx.actions.openLighting(account, event.currentTarget)}
      />
    </span>
  );
}

export function EnableToggle({ account, ctx }: { account: QuotaAccount; ctx: ControlsContext }) {
  const { t } = useI18n();
  return (
    <Toggle
      size="sm"
      checked={!account.disabled}
      label={account.toggleable ? t('sec.quota.enable') : t('sec.quota.enable.fileOnly')}
      disabled={!account.toggleable || ctx.busyKeys.has(account.key)}
      onChange={(next) => ctx.actions.setEnabled(account, next)}
    />
  );
}

export function AccountControls({ account, ctx, size = 'sm', toggle = true }: { account: QuotaAccount; ctx: ControlsContext; size?: 'xs' | 'sm' | 'md'; toggle?: boolean }) {
  const { t } = useI18n();
  const refreshLabel = account.disabled ? t('sec.quota.refresh.disabled') : !account.canFetch ? t('sec.quota.refresh.noIndex') : t('sec.quota.refresh');
  return (
    <div className="qt-controls">
      <BankedBadge account={account} ctx={ctx} />
      <LightningButton account={account} ctx={ctx} size={size} />
      <IconButton
        label={refreshLabel}
        size={size}
        icon={<RefreshCw size={14} className={account.loading ? 'qt-spin' : undefined} />}
        disabled={!account.canFetch || account.loading}
        onClick={() => ctx.actions.refresh(account)}
      />
      {toggle ? <EnableToggle account={account} ctx={ctx} /> : null}
    </div>
  );
}
