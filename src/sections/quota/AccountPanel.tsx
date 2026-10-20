// Account detail (C2): windows with big numbers, lighting status, banked resets, cooldowns, enable toggle and
// links to the pages that own credential editing and request history. Nothing from those pages is repeated.
import { ArrowRight, Clock, RefreshCw, RotateCcw, Zap } from 'lucide-react';
import {
  Button, Chip, Countdown, Masked, ProviderLogo, ProviderName, QuotaBar, RelativeTime, SidePanel,
  StatusPill, Toggle,
} from '../../ui';
import { useI18n } from '../../i18n';
import { formatShortDateTime } from '../../services/format';
import { routeHref } from '../../shell/router';
import { authFileRequestStats } from '../../services/authFileRequests';
import { canResetQuota } from '../../services/quotaActions';
import { cooldownReasonKey } from '../../services/authFileHealth';
import { AccountControls, type ControlsContext } from './AccountControls';
import { lightingRuleSummary } from './LightningPopover';
import { lightingStateOf } from './useLighting';
import type { QuotaAccount, WindowView } from './model';
import { ResetTime, windowLabel } from './WindowMeter';

export function BigWindow({ window, now, stale }: { window: WindowView; now: number; stale: boolean }) {
  const { t, formatNumber, locale } = useI18n();
  const label = windowLabel(window, t, true);
  const absolute = window.resetAtMs
    ? formatShortDateTime(window.resetAtMs, locale) : '';
  return (
    <div className={`qt-big${stale ? ' qt-stale' : ''}`}>
      <div className="qt-big__label" title={window.rawLabel}>{label}</div>
      <div className="qt-big__num ec-num">
        {window.quotaAvailable ? <span className="qt-big__available">{t('quota.service.antigravity.available')}</span> : <>{window.leftPct === null ? '—' : formatNumber(Math.round(window.leftPct))}<small>{window.leftPct === null ? '' : '% '}{t('sec.quota.left')}</small></>}
      </div>
      <QuotaBar leftPct={window.leftPct} height={8} trackSegments={20} label={label} />
      <div className="qt-big__reset">
        <span>{t('sec.quota.resets')} <ResetTime ms={window.resetAtMs} now={now} /></span>
        {absolute ? <span className="ec-mono ec-muted">{absolute}</span> : null}
      </div>
      {window.detail ? <div className="qt-big__detail ec-muted">{window.detail}</div> : null}
    </div>
  );
}

/** Consecutive windows of the same model group (Antigravity), so each group gets a heading and its description. */
function groupWindows(windows: WindowView[]): Array<{ label?: string; description?: string; windows: WindowView[] }> {
  const groups: Array<{ label?: string; description?: string; windows: WindowView[] }> = [];
  for (const window of windows) {
    const previous = groups[groups.length - 1];
    if (previous && previous.label === window.groupLabel) previous.windows.push(window);
    else groups.push({ label: window.groupLabel, description: window.groupDescription, windows: [window] });
  }
  return groups;
}

export function AccountPanel({
  account, ctx, onClose,
}: { account: QuotaAccount | null; ctx: ControlsContext; onClose: () => void }) {
  const { t, formatNumber } = useI18n();
  const open = account !== null;
  const view = account;
  const stats = view ? authFileRequestStats(view.file) : null;
  const requests = stats && stats.success !== null ? stats.success + (stats.failure ?? 0) : null;
  const schedule = view ? ctx.lighting.scheduleFor(view) : undefined;
  const lightState = lightingStateOf(schedule, ctx.lighting.status?.runningIds ?? [], ctx.now);
  const busy = view ? ctx.busyKeys.has(view.key) : false;

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      width={560}
      ariaLabel={t('sec.quota.panel.title')}
      title={view ? (
        <span className="qt-panel__title">
          <ProviderLogo provider={view.provider} size={26} />
          <span>
            <span className="qt-panel__name"><ProviderName provider={view.provider} />{view.plan ? <Chip size="sm"><Masked value={view.plan} identities={view.identities} /></Chip> : null}</span>
            <Masked className="qt-panel__sub ec-trunc" value={view.label} identities={view.identities} />
          </span>
        </span>
      ) : ''}
      actions={view ? <AccountControls account={view} ctx={ctx} size="md" toggle={false} /> : undefined}
    >
      {view ? (
        <div className="qt-panel">
          <div className="qt-panel__status">
            <StatusPill status={view.status} />
            {view.statusDetail ? <span className="qt-panel__detail ec-muted" title={view.statusDetail}>{view.statusDetail}</span> : null}
            {view.fetchedAt !== undefined ? (
              <span className={`qt-fetched${view.stale ? ' qt-fetched--stale' : ''}`}>{view.stale ? t('sec.quota.stale') : t('sec.quota.fetched')} <RelativeTime value={view.fetchedAt} /></span>
            ) : null}
            <span className="qt-spacer" />
            <Button size="xs" variant="outline" icon={<RefreshCw size={12} className={view.loading ? 'qt-spin' : undefined} />} disabled={!view.canFetch || view.loading} onClick={() => ctx.actions.refresh(view)}>{t('sec.quota.refresh')}</Button>
          </div>

          <section aria-label={t('sec.quota.panel.windows')}>
            {view.windows.length ? (
              <>{groupWindows(view.windows).map((group, index) => (
                <div className="qt-mgroup" key={index}>
                  {group.label ? <div className="qt-mgroup__head"><h3>{group.label}</h3>{group.description ? <p className="ec-muted">{group.description}</p> : null}</div> : null}
                  <div className="qt-bigs">{group.windows.map((window) => <BigWindow key={window.id} window={window} now={ctx.now} stale={view.stale} />)}</div>
                </div>
              ))}</>
            ) : view.status === 'notFetched' ? (
              // The status pill already says "Not fetched"; the body only offers the action.
              <div className="qt-panel__none">
                <Button size="xs" variant="outline" disabled={!view.canFetch || view.loading} onClick={() => ctx.actions.refresh(view)}>{t('sec.quota.fetch')}</Button>
              </div>
            ) : <div className="qt-panel__none ec-muted">{t('sec.quota.noWindows')}</div>}
            {view.creditBalance !== undefined || view.creditsUnlimited ? (
              <div className="qt-credit"><span>{t('sec.quota.credits')}</span><span className="ec-mono">{view.creditsUnlimited ? t('sec.quota.unlimited') : view.creditBalance}</span></div>
            ) : null}
          </section>

          <section className="qt-block" aria-label={t('sec.quota.lighting.title')}>
            <header><Zap size={13} aria-hidden="true" /><h3>{t('sec.quota.lighting.title')}</h3></header>
            {schedule && lightState !== 'off' ? (
              <div className="qt-block__body">
                <span>{lightingRuleSummary(schedule, t)}</span>
                <span className="ec-muted">
                  {schedule.nextRun && schedule.nextRun > ctx.now ? <>{t('sec.quota.lighting.next')} <Countdown to={schedule.nextRun} compact /></> : t(`sec.quota.lighting.state.${lightState}` as never)}
                </span>
              </div>
            ) : <div className="qt-block__body ec-muted">{t('sec.quota.lighting.mode.off')}</div>}
            <Button size="xs" variant="outline" onClick={(event) => ctx.actions.openLighting(view, event.currentTarget)}>{t('sec.quota.lighting.configure')}</Button>
          </section>

          {view.banked ? (
            <section className="qt-block" aria-label={t('sec.quota.banked.heading')}>
              <header><RotateCcw size={13} aria-hidden="true" /><h3>{t('sec.quota.banked.heading')}</h3><Chip size="sm" tone={view.banked.useSoon ? 'warn' : 'neutral'}>{formatNumber(view.banked.count)}</Chip></header>
              <ul className="qt-expiries">
                {view.banked.expiries.map((expiry, index) => (
                  <li key={`${expiry}-${index}`}><span>{t('quota.resetCreditExpiry', { index: index + 1 })}</span><span className="ec-mono"><ResetTime ms={Date.parse(expiry)} now={ctx.now} /></span></li>
                ))}
              </ul>
              {view.banked.useSoon ? <div className="qt-note qt-note--cooldown">{t('sec.quota.banked.useSoon')}</div> : null}
              <Button size="xs" variant="primary" disabled={!canResetQuota(view.file, view.quota)} onClick={() => ctx.actions.consume(view)}>
                {view.banked.pendingClaude ? t('quota.claude.retry') : t('sec.quota.banked.useButton')}
              </Button>
            </section>
          ) : null}

          {view.cooldown.active.length ? (
            <section className="qt-block" aria-label={t('sec.quota.cooldown.heading')}>
              <header><Clock size={13} aria-hidden="true" /><h3>{t('sec.quota.cooldown.heading')}</h3></header>
              <ul className="qt-expiries">
                {view.cooldown.active.map(({ record, remainingSeconds }, index) => (
                  <li key={`${record.scope}-${record.model ?? ''}-${index}`}>
                    <span>{record.scope === 'model' ? <span className="ec-mono">{record.model}</span> : t('sec.quota.cooldown.credential')} · {t(cooldownReasonKey(record.reason))}{record.httpStatus ? ` · ${record.httpStatus}` : ''}</span>
                    <span className="ec-mono"><Countdown to={ctx.now + remainingSeconds * 1000} compact /></span>
                  </li>
                ))}
              </ul>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => ctx.actions.clearCooldown(view)}>{t('authFiles.cooldown.resetButton')}</Button>
            </section>
          ) : null}

          <section className="qt-block qt-block--row">
            <span>{t('sec.quota.enable')}</span>
            <Toggle checked={!view.disabled} label={view.toggleable ? t('sec.quota.enable') : t('sec.quota.enable.fileOnly')} disabled={!view.toggleable || busy} onChange={(next) => ctx.actions.setEnabled(view, next)} />
          </section>
          <div className="qt-panel__links">
            <a className="qt-link" href={routeHref('providers', null, { cred: view.fileName })}>{t('sec.quota.editCredential')} <ArrowRight size={12} aria-hidden="true" /></a>
            <a className="qt-link" href={routeHref('usage', 'requests', { account: view.fileName })}>
              {requests !== null ? t('sec.quota.requests', { count: formatNumber(requests) }) : t('sec.quota.requestsLink')} <ArrowRight size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : null}
    </SidePanel>
  );
}
