// Timeline: when does each account's window recover? One row per account, a bar from now to the reset of the chosen
// window (coloured by % left), plus markers for the next lighting run (⚡) and banked-reset expiries (↻).
import { useState } from 'react';
import { RotateCcw, Zap } from 'lucide-react';
import { Masked, ProviderLogo, SegmentedControl, StatusPill } from '../../ui';
import { useI18n } from '../../i18n';
import type { QuotaAccount } from './model';
import { tightest, ResetTime } from './WindowMeter';
import type { ControlsContext } from './AccountControls';

type Range = '5h' | 'weekly';
const RANGE_MS: Record<Range, number> = { '5h': 5 * 3_600_000, weekly: 7 * 24 * 3_600_000 };

const tone = (pct: number | null) => pct === null ? 'none' : pct >= 50 ? 'ok' : pct >= 20 ? 'warn' : 'danger';

export function TimelineView({ accounts, ctx, selectedKey }: { accounts: QuotaAccount[]; ctx: ControlsContext; selectedKey: string | null }) {
  const { t, formatNumber } = useI18n();
  const [range, setRange] = useState<Range>('5h');
  const span = RANGE_MS[range];
  const at = (ms: number) => ((ms - ctx.now) / span) * 100;
  const ticks = range === '5h' ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7];

  const rows = accounts.map((account) => {
    const window = tightest(account.windows, range);
    const reset = window?.resetAtMs !== undefined && window.resetAtMs > ctx.now && (window.leftPct ?? 100) < 100 ? window.resetAtMs : undefined;
    return { account, window, reset };
  }).sort((a, b) => (a.reset ?? Infinity) - (b.reset ?? Infinity));

  return (
    <section className="qt-timeline" aria-label={t('sec.quota.view.timeline')}>
      <div className="qt-timeline__bar">
        <SegmentedControl<Range>
          ariaLabel={t('sec.quota.timeline.range')}
          size="sm"
          value={range}
          onChange={setRange}
          options={[{ value: '5h', label: t('sec.quota.timeline.next5h') }, { value: 'weekly', label: t('sec.quota.timeline.next7d') }]}
        />
        <span className="qt-timeline__legend ec-muted"><Zap size={11} aria-hidden="true" /> {t('sec.quota.timeline.light')} <RotateCcw size={11} aria-hidden="true" /> {t('sec.quota.timeline.banked')}</span>
      </div>
      <div className="qt-tl">
        <div className="qt-tl__row qt-tl__row--axis" aria-hidden="true">
          <span />
          <div className="qt-tl__track">
            {ticks.map((tick) => (
              <span key={tick} className="qt-tl__tick ec-mono" style={{ left: `${(tick / ticks[ticks.length - 1]) * 100}%` }}>
                {tick === 0 ? t('sec.quota.timeline.now') : t(range === '5h' ? 'sec.quota.timeline.tickH' : 'sec.quota.timeline.tickD', { n: tick })}
              </span>
            ))}
          </div>
          <span />
        </div>
        {rows.map(({ account, window, reset }) => {
          const schedule = ctx.lighting.scheduleFor(account);
          const lightAt = schedule?.enabled && schedule.nextRun && schedule.nextRun > ctx.now && schedule.nextRun - ctx.now <= span ? schedule.nextRun : undefined;
          const banked = (account.banked?.expiries ?? []).map((expiry) => Date.parse(expiry)).filter((ms) => Number.isFinite(ms) && ms > ctx.now && ms - ctx.now <= span);
          const pct = window?.leftPct ?? null;
          return (
            <div
              key={account.key}
              className={`qt-tl__row${selectedKey === account.key ? ' is-selected' : ''}${account.disabled ? ' is-disabled' : ''}`}
              data-account={account.key}
            >
              <button type="button" className="qt-tl__who" onClick={() => ctx.actions.open(account)}>
                <ProviderLogo provider={account.provider} size={18} />
                <Masked className="ec-trunc" value={account.label} identities={account.identities} />
              </button>
              <div className="qt-tl__track">
                {reset !== undefined ? (
                  <span className={`qt-tl__fill qt-tl__fill--${tone(pct)}${account.stale ? ' qt-stale' : ''}`} style={{ width: `${Math.min(100, Math.max(1.5, at(reset)))}%` }}>
                  </span>
                ) : window && account.status !== 'disabled' && account.status !== 'expired' ? <span className="qt-tl__none ec-muted">{t('sec.quota.timeline.noReset')}</span>
                  : <span className="qt-tl__none"><StatusPill status={account.status} size="sm" /></span>}
                {lightAt !== undefined ? <span className="qt-tl__mark qt-tl__mark--light" style={{ left: `${at(lightAt)}%` }} title={t('sec.quota.timeline.light')}><Zap size={12} fill="currentColor" aria-hidden="true" /></span> : null}
                {banked.map((ms) => <span key={ms} className="qt-tl__mark qt-tl__mark--banked" style={{ left: `${at(ms)}%` }} title={t('sec.quota.timeline.banked')}><RotateCcw size={12} aria-hidden="true" /></span>)}
              </div>
              <span className="qt-tl__reset ec-mono">{reset !== undefined ? <><b className="ec-num">{pct === null ? '' : `${formatNumber(Math.round(pct))}%`}</b> <ResetTime ms={reset} now={ctx.now} /></> : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
