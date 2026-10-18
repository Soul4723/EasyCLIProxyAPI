// Lighting popover (C1 shape): Off · After reset · Schedule, window, start time presets, weekdays, model, retry,
// status (next run / last result / paused / no reset known) and "Light now". Backed by src/services/lighting.ts.
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { CheckCircle2, CircleAlert, Zap } from 'lucide-react';
import {
  Button, ConfirmDialog, Countdown, Masked, Popover, ProviderLogo, ProviderName, SegmentedControl,
} from '../../ui';
import { useI18n } from '../../i18n';
import type { LightingMode, LightingSchedule, LightingWindowKind } from '../../services/lighting';
import type { QuotaAccount } from './model';
import { lightingStateOf, type LightingApi } from './useLighting';

type FormMode = 'off' | LightingMode;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const PRESETS = ['05:30', '06:00', '07:00'];
const DEFAULT_RETRY = { maxAttempts: 3, intervalSeconds: 60, backoff: 2, circuitSeconds: 900 };
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function lightingRuleSummary(schedule: LightingSchedule, t: ReturnType<typeof useI18n>['t']): string {
  const window = schedule.windowKind === '5h' ? t('sec.quota.win.5h') : t('sec.quota.win.week');
  if (schedule.mode === 'after_reset') return t('sec.quota.lighting.rule.afterReset', { window });
  const days = schedule.weekdays.length === 7 ? t('sec.quota.lighting.daily')
    : schedule.weekdays.join(',') === '1,2,3,4,5' ? t('sec.quota.lighting.weekdays') : schedule.weekdays.map((day) => t(`sec.quota.day.${day}` as never)).join(' ');
  return `${t('sec.quota.lighting.rule.schedule', { time: schedule.times[0] ?? '—', window })} · ${days}`;
}

export function LightningPopover({
  account, anchorRef, open, onClose, lighting, now, onSaved,
}: {
  account: QuotaAccount;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  lighting: LightingApi;
  now: number;
  onSaved: (schedule: LightingSchedule) => void;
}) {
  const { t, locale } = useI18n();
  const schedule = lighting.scheduleFor(account);
  const capability = lighting.capabilityFor(account.provider);
  const windows: LightingWindowKind[] = capability?.allowedWindows.length ? capability.allowedWindows : ['5h', 'weekly'];
  const initial = useMemo(() => ({
    mode: (schedule && schedule.enabled ? schedule.mode : 'off') as FormMode,
    windowKind: (schedule?.windowKind ?? '5h') as LightingWindowKind,
    time: schedule?.times[0] ?? '06:00',
    weekdays: schedule?.weekdays ?? WEEKDAYS,
    model: schedule?.model ?? '',
    attempts: schedule?.retry.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    interval: schedule?.retry.intervalSeconds ?? DEFAULT_RETRY.intervalSeconds,
  }), [schedule]);
  const [mode, setMode] = useState<FormMode>(initial.mode);
  const [windowKind, setWindowKind] = useState(initial.windowKind);
  const [time, setTime] = useState(initial.time);
  const [weekdays, setWeekdays] = useState<number[]>(initial.weekdays);
  const [model, setModel] = useState(initial.model);
  const [attempts, setAttempts] = useState(initial.attempts);
  const [interval, setInterval] = useState(initial.interval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmNow, setConfirmNow] = useState(false);
  const [lastRunNote, setLastRunNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode(initial.mode); setWindowKind(initial.windowKind); setTime(initial.time); setWeekdays(initial.weekdays);
    setModel(initial.model); setAttempts(initial.attempts); setInterval(initial.interval); setError(''); setLastRunNote('');
    // Reset the form only when the popover opens or the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account.key]);

  const state = lightingStateOf(schedule, lighting.status?.runningIds ?? [], now);
  const timeValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const valid = mode === 'off' || (weekdays.length > 0 && (mode === 'after_reset' || timeValid)
    && attempts >= 1 && attempts <= 10 && interval >= 1 && interval <= 86400);

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (mode === 'off') {
        if (schedule?.enabled) await lighting.setEnabled(schedule, false);
        onClose();
        return;
      }
      const draft: LightingSchedule = {
        id: schedule?.id ?? '',
        credential: { provider: account.provider, authFileName: account.fileName, authIndex: account.authIndex },
        target: lighting.status?.currentTarget ?? schedule?.target ?? '',
        enabled: true,
        mode,
        times: mode === 'schedule' ? [time] : [],
        weekdays: [...weekdays].sort(),
        timezone: schedule?.timezone ?? localZone(),
        windowKind,
        model: model.trim() || null,
        activeHours: schedule?.activeHours ?? null,
        retry: { ...(schedule?.retry ?? DEFAULT_RETRY), maxAttempts: attempts, intervalSeconds: interval },
        lastRun: schedule?.lastRun ?? null, nextRun: null,
        observedReset: schedule?.observedReset ?? null, consumedReset: schedule?.consumedReset ?? null,
        attempt: 0, circuitUntil: null,
      };
      const saved = await lighting.save(draft);
      onSaved(saved);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const lightNow = async () => {
    if (!schedule) return;
    setConfirmNow(false); setBusy(true); setError('');
    try {
      const result = await lighting.runNow(schedule);
      setLastRunNote(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!schedule) return;
    setBusy(true); setError('');
    try { await lighting.remove(schedule); onClose(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const fmt = (ms: number) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
  const defaultModel = capability?.defaultModel ?? '';

  return (
    <>
      <Popover open={open} onClose={onClose} anchorRef={anchorRef} align="end" width={340} label={t('sec.quota.lighting.title')}>
        <div className="qt-pop">
          <div className="qt-pop__head">
            <ProviderLogo provider={account.provider} size={20} />
            <strong>{t('sec.quota.lighting.title')}</strong>
            <span className="qt-pop__who ec-mono"><ProviderName provider={account.provider} /> · <Masked value={account.label} identities={account.identities} /></span>
          </div>

          <SegmentedControl<FormMode>
            ariaLabel={t('sec.quota.lighting.mode')}
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'off', label: t('sec.quota.lighting.mode.off') },
              { value: 'after_reset', label: t('sec.quota.lighting.mode.afterReset') },
              { value: 'schedule', label: t('sec.quota.lighting.mode.schedule') },
            ]}
          />

          {mode !== 'off' ? (
            <>
              <div className="qt-pop__row">
                <span className="qt-pop__label">{t('sec.quota.lighting.window')}</span>
                <SegmentedControl<LightingWindowKind>
                  ariaLabel={t('sec.quota.lighting.window')}
                  size="sm"
                  value={windowKind}
                  onChange={setWindowKind}
                  options={windows.map((kind) => ({ value: kind, label: kind === '5h' ? t('sec.quota.win.5h') : t('sec.quota.win.week') }))}
                />
              </div>

              {mode === 'schedule' ? (
                <div className="qt-pop__row qt-pop__row--wrap">
                  <span className="qt-pop__label">{t('sec.quota.lighting.startAt')}</span>
                  <input className="qt-input ec-mono" type="time" value={time} aria-label={t('sec.quota.lighting.startAt')} onChange={(event) => setTime(event.target.value)} />
                  <div className="qt-presets">
                    {PRESETS.map((preset) => (
                      <button key={preset} type="button" className={`qt-preset${time === preset ? ' is-on' : ''}`} onClick={() => setTime(preset)}>{preset}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={`qt-pop__hint${schedule?.observedReset ? '' : ' qt-pop__hint--warn'}`}>
                  {schedule?.observedReset
                    ? <>{t('sec.quota.lighting.observed')} <span className="ec-mono">{fmt(schedule.observedReset)}</span></>
                    : t('sec.quota.lighting.noReset')}
                </div>
              )}

              <div className="qt-pop__row qt-pop__row--wrap">
                <span className="qt-pop__label">{t('sec.quota.lighting.days')}</span>
                <div className="qt-days" role="group" aria-label={t('sec.quota.lighting.days')}>
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={weekdays.includes(day)}
                      className={`qt-day${weekdays.includes(day) ? ' is-on' : ''}`}
                      onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day])}
                    >{t(`sec.quota.day.${day}` as never)}</button>
                  ))}
                </div>
              </div>

              <div className="qt-pop__row">
                <span className="qt-pop__label">{t('sec.quota.lighting.model')}</span>
                <input className="qt-input ec-mono" value={model} placeholder={defaultModel} aria-label={t('sec.quota.lighting.model')} onChange={(event) => setModel(event.target.value)} />
              </div>

              <div className="qt-pop__row">
                <span className="qt-pop__label">{t('sec.quota.lighting.retry')}</span>
                <input className="qt-input qt-input--num ec-mono" type="number" min={1} max={10} value={attempts} aria-label={t('sec.quota.lighting.attempts')} onChange={(event) => setAttempts(Number(event.target.value))} />
                <span className="ec-muted">×</span>
                <input className="qt-input qt-input--num ec-mono" type="number" min={1} max={86400} value={interval} aria-label={t('sec.quota.lighting.interval')} onChange={(event) => setInterval(Number(event.target.value))} />
                <span className="ec-muted">s</span>
              </div>
              <div className="qt-pop__tz ec-muted">{t('sec.quota.lighting.timezone', { zone: schedule?.timezone ?? localZone() })}</div>
            </>
          ) : null}

          {schedule ? (
            <div className={`qt-pop__status qt-pop__status--${state}`}>
              <div className="qt-pop__rule">{lightingRuleSummary(schedule, t)}</div>
              <dl>
                <div><dt>{t('sec.quota.lighting.next')}</dt><dd className="ec-mono">{schedule.enabled && schedule.nextRun && schedule.nextRun > now ? <><Countdown to={schedule.nextRun} /> · {fmt(schedule.nextRun)}</> : '—'}</dd></div>
                <div><dt>{t('sec.quota.lighting.last')}</dt><dd>
                  {schedule.lastRun
                    ? <span className={schedule.lastRun.ok ? 'qt-ok' : 'qt-bad'} title={schedule.lastRun.message}>
                      {schedule.lastRun.ok ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
                      {' '}{schedule.lastRun.httpStatus ?? '—'} · {fmt(schedule.lastRun.at)}
                    </span> : '—'}
                </dd></div>
                {state === 'paused' && schedule.circuitUntil ? (
                  <div><dt>{t('sec.quota.lighting.paused')}</dt><dd className="ec-mono qt-bad">{t('sec.quota.lighting.resumes', { time: fmt(schedule.circuitUntil) })}</dd></div>
                ) : null}
              </dl>
              {schedule.lastRun && !schedule.lastRun.ok ? <div className="qt-pop__msg qt-bad">{schedule.lastRun.message}</div> : null}
            </div>
          ) : null}

          {lastRunNote ? <div className="qt-pop__msg">{lastRunNote}</div> : null}
          {error ? <div className="qt-pop__msg qt-bad" role="alert">{error}</div> : null}
          <div className="qt-pop__note ec-muted">{t('sec.quota.lighting.cost')} {t('sec.quota.lighting.onlyWhileOpen')}</div>

          <div className="qt-pop__foot">
            <Button size="xs" variant="outline" icon={<Zap size={12} />} disabled={!schedule || busy} onClick={() => setConfirmNow(true)}>{t('sec.quota.lighting.now')}</Button>
            {schedule ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove()}>{t('sec.quota.lighting.remove')}</Button> : null}
            <span className="qt-spacer" />
            <Button size="xs" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="xs" variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>{t('common.save')}</Button>
          </div>
        </div>
      </Popover>
      <ConfirmDialog
        open={confirmNow}
        title={t('sec.quota.lighting.nowTitle')}
        message={<p>{t('sec.quota.lighting.nowMessage', { model: model.trim() || defaultModel || '—' })}</p>}
        confirmLabel={t('sec.quota.lighting.now')}
        onConfirm={() => void lightNow()}
        onCancel={() => setConfirmNow(false)}
      />
    </>
  );
}
