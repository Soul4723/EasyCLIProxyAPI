// An account as a C1 card or as a compact one-line row with fixed window columns.
import { memo } from 'react';
import { AlertCircle, Clock, LogIn } from 'lucide-react';
import {
  Button, Chip, Countdown, Masked, ProviderLogo, ProviderName, QuotaBar, RelativeTime, Skeleton, StatusPill,
} from '../../ui';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import { AccountControls, EnableToggle, type ControlsContext } from './AccountControls';
import { lightingStateOf } from './useLighting';
import type { QuotaAccount } from './model';
import { ResetTime, WindowMeter, tightest, windowLabel } from './WindowMeter';

const MAX_CARD_WINDOWS = 3;

function Identity({ account, ctx, selected, grouped, plan = true }: { account: QuotaAccount; ctx: ControlsContext; selected: boolean; grouped?: boolean; plan?: boolean }) {
  return (
    <button type="button" className="qt-identity" aria-pressed={selected} onClick={() => ctx.actions.open(account)}>
      <ProviderLogo provider={account.provider} size={28} />
      <span className="qt-identity__text">
        {grouped ? (
          <span className="qt-identity__top">
            <Masked className="qt-identity__provider ec-trunc" value={account.label} identities={account.identities} />
            {plan && account.plan ? <Chip size="sm"><Masked value={account.plan} identities={account.identities} /></Chip> : null}
          </span>
        ) : (
          <>
            <span className="qt-identity__top">
              <span className="qt-identity__provider"><ProviderName provider={account.provider} /></span>
              {account.plan ? <Chip size="sm"><Masked value={account.plan} identities={account.identities} /></Chip> : null}
            </span>
            <Masked className="qt-identity__sub ec-trunc" value={account.label} identities={account.identities} />
          </>
        )}
      </span>
    </button>
  );
}

function CooldownLine({ account }: { account: QuotaAccount }) {
  const { t } = useI18n();
  if (!account.cooldown.active.length) return null;
  const first = account.cooldown.active[0].record;
  const scope = account.cooldown.credentialWide
    ? t('sec.quota.cooldown.credential')
    : t('sec.quota.cooldown.models', { count: account.cooldown.modelCount });
  return (
    <div className="qt-note qt-note--cooldown" title={first.reason}>
      <Clock size={12} aria-hidden="true" />
      <span>{scope}</span>
      <Countdown to={Date.now() + account.cooldown.earliestSeconds * 1000} compact />
    </div>
  );
}

function LightingLine({ account, ctx }: { account: QuotaAccount; ctx: ControlsContext }) {
  const { t } = useI18n();
  const schedule = ctx.lighting.scheduleFor(account);
  const state = lightingStateOf(schedule, ctx.lighting.status?.runningIds ?? [], ctx.now);
  if (!schedule || state === 'off') return null;
  const rule = schedule.mode === 'after_reset'
    ? t('sec.quota.lighting.rule.afterReset', { window: schedule.windowKind === '5h' ? t('sec.quota.win.5h') : t('sec.quota.win.week') })
    : t('sec.quota.lighting.rule.schedule', { time: schedule.times[0] ?? '—', window: schedule.windowKind === '5h' ? t('sec.quota.win.5h') : t('sec.quota.win.week') });
  return (
    <div className={`qt-note qt-note--light qt-note--${state}`}>
      <span className="qt-note__rule">{rule}</span>
      {schedule.nextRun && schedule.nextRun > ctx.now ? <span className="ec-mono">· <Countdown to={schedule.nextRun} compact /></span> : <span>{t(`sec.quota.lighting.state.${state}` as never)}</span>}
    </div>
  );
}

function FetchedLine({ account }: { account: QuotaAccount }) {
  const { t } = useI18n();
  if (account.fetchedAt === undefined) return null;
  return (
    <span className={`qt-fetched${account.stale ? ' qt-fetched--stale' : ''}`}>
      {account.stale ? t('sec.quota.stale') : t('sec.quota.fetched')} <RelativeTime value={account.fetchedAt} />
    </span>
  );
}

function CardBody({ account, ctx }: { account: QuotaAccount; ctx: ControlsContext }) {
  const { t } = useI18n();
  if (account.loading && account.windows.length === 0) return <Skeleton lines={2} height={12} />;
  if (account.status === 'notFetched' && account.windows.length === 0) {
    return (
      <div className="qt-empty qt-empty--end">
        <Button size="xs" variant="outline" disabled={!account.canFetch} onClick={() => ctx.actions.refresh(account)}>{t('sec.quota.fetch')}</Button>
      </div>
    );
  }
  if (account.status === 'expired') {
    return (
      <div className="qt-empty qt-empty--bad">
        <span title={account.statusDetail || undefined}><AlertCircle size={13} aria-hidden="true" /> {t('sec.quota.expired')}</span>
        <a className="qt-link" href={routeHref('providers', null, { cred: account.fileName })}><LogIn size={12} aria-hidden="true" /> {t('sec.quota.signIn')}</a>
      </div>
    );
  }
  if (account.status === 'error' && account.windows.length === 0) {
    return (
      <div className="qt-empty qt-empty--bad">
        <span className="qt-empty__err" title={account.statusDetail}><AlertCircle size={13} aria-hidden="true" /> {account.statusDetail || t('sec.quota.error')}</span>
        <Button size="xs" variant="outline" disabled={!account.canFetch} onClick={() => ctx.actions.refresh(account)}>{t('common.retry')}</Button>
      </div>
    );
  }
  const shown = account.windows.slice(0, MAX_CARD_WINDOWS);
  const more = account.windows.length - shown.length;
  return (
    <div className="qt-wins">
      {shown.map((window) => <WindowMeter key={window.id} window={window} now={ctx.now} stale={account.stale} />)}
      {more > 0 ? <button type="button" className="qt-more" onClick={() => ctx.actions.open(account)}>{t('sec.quota.moreWindows', { count: more })}</button> : null}
      {account.windows.length === 0 ? <span className="qt-fetched">{t('sec.quota.noWindows')}</span> : null}
      {account.creditBalance !== undefined || account.creditsUnlimited ? (
        <div className="qt-credit"><span>{t('sec.quota.credits')}</span><span className="ec-mono">{account.creditsUnlimited ? t('sec.quota.unlimited') : account.creditBalance}</span></div>
      ) : null}
    </div>
  );
}

type ItemProps = { account: QuotaAccount; ctx: ControlsContext; selected: boolean; grouped?: boolean };

/**
 * What a card or row derives from `ctx.now`: which reset times have passed and the lighting state/countdown.
 * Countdown and RelativeTime text tick on their own clock, so a tick that leaves these unchanged needs no render.
 */
function timeFacts({ account, ctx }: ItemProps): string {
  const schedule = ctx.lighting.scheduleFor(account);
  const state = lightingStateOf(schedule, ctx.lighting.status?.runningIds ?? [], ctx.now);
  const passed = (ms: number | undefined) => (ms !== undefined && ms <= ctx.now ? 1 : 0);
  return [passed(account.nextResetMs), ...account.windows.map((window) => passed(window.resetAtMs)),
    state, (schedule?.nextRun ?? 0) > ctx.now ? 'next' : ''].join();
}

/** Memo comparison: re-render for a new account, selection, lighting, actions, own busy flag or a crossed time boundary. */
export function sameItemProps(prev: ItemProps, next: ItemProps): boolean {
  return prev.account === next.account && prev.selected === next.selected && prev.grouped === next.grouped
    && prev.ctx.lighting === next.ctx.lighting && prev.ctx.actions === next.ctx.actions
    && prev.ctx.busyKeys.has(prev.account.key) === next.ctx.busyKeys.has(next.account.key)
    && (prev.ctx.now === next.ctx.now || timeFacts(prev) === timeFacts(next));
}

export const AccountCard = memo(function AccountCard({ account, ctx, selected, grouped }: ItemProps) {
  const open = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button,a,input,[role=switch]')) return;
    ctx.actions.open(account);
  };
  return (
    <article
      className={`qt-card qt-card--${account.status}${selected ? ' is-selected' : ''}${account.disabled ? ' is-disabled' : ''}`}
      aria-busy={account.loading}
      data-account={account.key}
      data-status={account.status}
      onClick={open}
    >
      <header className="qt-card__head">
        <Identity account={account} ctx={ctx} selected={selected} grouped={grouped} plan={!grouped} />
        <AccountControls account={account} ctx={ctx} toggle={false} />
      </header>
      <div className="qt-card__state">
        <span className="qt-card__count ec-muted">
          {grouped && account.plan ? <Chip size="sm"><Masked value={account.plan} identities={account.identities} /></Chip>
            : account.windows.length ? <WindowCount account={account} /> : null}
        </span>
        <span className="qt-card__stat"><StatusPill status={account.status} size="sm" /><EnableToggle account={account} ctx={ctx} /></span>
      </div>
      <CardBody account={account} ctx={ctx} />
      <CooldownLine account={account} />
      <footer className="qt-card__foot">
        <LightingLine account={account} ctx={ctx} />
        <FetchedLine account={account} />
      </footer>
    </article>
  );
}, sameItemProps);

function WindowCount({ account }: { account: QuotaAccount }) {
  const { t } = useI18n();
  return <>{t('sec.quota.windows', { count: account.windows.length })}</>;
}

function RowMeter({ account, kind, ctx }: { account: QuotaAccount; kind: '5h' | 'weekly'; ctx: ControlsContext }) {
  const { t, formatNumber } = useI18n();
  const window = tightest(account.windows, kind);
  if (!window) return <div className="qt-rowmeter qt-rowmeter--none ec-muted">—</div>;
  return (
    <div className={`qt-rowmeter${account.stale ? ' qt-stale' : ''}`} title={windowLabel(window, t)}>
      <div className="qt-rowmeter__top">
        <span className="qt-win__pct ec-num">{window.quotaAvailable ? t('quota.service.antigravity.available') : window.leftPct === null ? '—' : `${formatNumber(Math.round(window.leftPct))}%`}</span>
        <ResetTime ms={window.resetAtMs} now={ctx.now} />
      </div>
      <QuotaBar leftPct={window.leftPct} height={5} label={windowLabel(window, t)} />
    </div>
  );
}

export const AccountRow = memo(function AccountRow({ account, ctx, selected, grouped }: ItemProps) {
  const { t } = useI18n();
  const extra = account.windows.filter((window) => window !== tightest(account.windows, '5h') && window !== tightest(account.windows, 'weekly')).length;
  const open = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button,a,input,[role=switch]')) return;
    ctx.actions.open(account);
  };
  return (
    <div
     
      className={`qt-row qt-row--${account.status}${selected ? ' is-selected' : ''}${account.disabled ? ' is-disabled' : ''}`}
      data-account={account.key}
      data-status={account.status}
      aria-busy={account.loading}
      onClick={open}
    >
      <Identity account={account} ctx={ctx} selected={selected} grouped={grouped} />
      <div className="qt-row__status"><StatusPill status={account.status} size="sm" /></div>
      <RowMeter account={account} kind="5h" ctx={ctx} />
      <RowMeter account={account} kind="weekly" ctx={ctx} />
      <div className="qt-row__more ec-muted" title={t('sec.quota.moreWindows', { count: extra })}>{extra > 0 ? `+${extra}` : ''}</div>
      <div className="qt-row__next ec-mono"><ResetTime ms={account.nextResetMs} now={ctx.now} passed={false} /></div>
      <AccountControls account={account} ctx={ctx} />
    </div>
  );
}, sameItemProps);

export function RowsHeader() {
  const { t } = useI18n();
  return (
    <div className="qt-row qt-row--head" aria-hidden="true">
      <span>{t('sec.quota.col.account')}</span>
      <span>{t('sec.quota.col.status')}</span>
      <span>{t('sec.quota.win.5h')}</span>
      <span>{t('sec.quota.win.week')}</span>
      <span />
      <span>{t('sec.quota.col.next')}</span>
      <span />
    </div>
  );
}
