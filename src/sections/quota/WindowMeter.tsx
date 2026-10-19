// One quota window: label, % left bar (striped when the data is stale), % and reset countdown.
// Reset is relative first with the absolute local time in the tooltip; unknown reset is "—", never invented.
import { Countdown, QuotaBar } from '../../ui';
import { useI18n } from '../../i18n';
import { formatShortDateTime } from '../../services/format';
import type { WindowView } from './model';

type Translate = ReturnType<typeof useI18n>['t'];

export function windowLabel(window: WindowView, t: Translate): string {
  const base = window.kind === '5h' ? t('sec.quota.win.5h') : window.kind === 'weekly' ? t('sec.quota.win.week') : '';
  if (!base) return window.rawLabel.replace(/\s*(limit\s*)?remaining$/i, '').trim();
  return window.prefix ? `${window.prefix} ${base}` : base;
}

export function ResetTime({ ms, now, passed = true }: { ms?: number; now: number; passed?: boolean }) {
  const { t, locale } = useI18n();
  if (ms === undefined || !Number.isFinite(ms)) return <span className="qt-reset qt-reset--none">—</span>;
  const absolute = formatShortDateTime(ms, locale);
  if (ms <= now) return passed ? <span className="qt-reset qt-reset--passed" title={absolute}>{t('sec.quota.resetPassed')}</span> : null;
  return <span className="qt-reset ec-mono" title={absolute}><Countdown to={ms} compact /></span>;
}

export function WindowMeter({ window, now, stale }: { window: WindowView; now: number; stale: boolean }) {
  const { t, formatNumber } = useI18n();
  const label = windowLabel(window, t);
  const title = [window.rawLabel, window.detail, window.resetText].filter(Boolean).join(' · ');
  return (
    <div className={`qt-win${stale ? ' qt-stale' : ''}`} title={title || undefined}>
      <span className="qt-win__label">{label}</span>
      <QuotaBar leftPct={window.leftPct} height={6} label={label} />
      <span className="qt-win__pct ec-num">{window.quotaAvailable ? t('quota.service.antigravity.available') : window.leftPct === null ? '—' : `${formatNumber(Math.round(window.leftPct))}%`}</span>
      <ResetTime ms={window.resetAtMs} now={now} />
    </div>
  );
}

/** Tightest window of a kind (lowest % left), for fixed-column rows. */
export function tightest(windows: WindowView[], kind: WindowView['kind']): WindowView | undefined {
  const pool = windows.filter((window) => window.kind === kind);
  const plain = pool.filter((window) => window.prefix === '');
  const list = plain.length ? plain : pool;
  return list.slice().sort((a, b) => (a.leftPct ?? 101) - (b.leftPct ?? 101))[0];
}
