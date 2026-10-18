import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Info, RotateCcw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useCoreRuntime } from '../../coreRuntime';
import { APP_NAVIGATION_REQUEST_EVENT, type AppNavigationRequest } from '../../navigation';
import { Button, Card, ConfirmDialog, Chip } from '../../ui';
import type { MessageKey } from '../../i18n/resources';

/**
 * Shared building blocks for every Settings tab.
 *
 * - SettingsGroup: titled card; its children are SettingRows.
 * - SettingRow: label (+ optional hint as tooltip, effect chip) on the left, control on the right.
 * - SaveBar: sticky unsaved-changes bar (count, Discard, Save). Render it only while a tab owns a draft.
 * - useReportDirty(tabId, dirty): tells the page nav (dot) and the leave guard that a tab has unsaved changes.
 */

type DirtyApi = { setDirty: (tab: string, dirty: boolean) => void };
export const SettingsDirtyContext = createContext<DirtyApi>({ setDirty: () => undefined });

export function useReportDirty(tab: string, dirty: boolean) {
  const { setDirty } = useContext(SettingsDirtyContext);
  useEffect(() => {
    setDirty(tab, dirty);
    return () => setDirty(tab, false);
  }, [tab, dirty, setDirty]);
}

/** Owns the dirty map for the page and blocks in-app navigation while something is unsaved. */
export function useSettingsDirtyState() {
  const { t } = useI18n();
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<(() => void) | null>(null);
  const anyDirty = Object.values(dirtyTabs).some(Boolean);
  const anyDirtyRef = useRef(false);
  anyDirtyRef.current = anyDirty;
  const setDirty = useCallback((tab: string, dirty: boolean) => {
    setDirtyTabs((current) => (Boolean(current[tab]) === dirty ? current : { ...current, [tab]: dirty }));
  }, []);
  useEffect(() => {
    const onRequest = (event: Event) => {
      if (!anyDirtyRef.current) return;
      event.preventDefault();
      setPending(() => (event as AppNavigationRequest).detail);
    };
    window.addEventListener(APP_NAVIGATION_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(APP_NAVIGATION_REQUEST_EVENT, onRequest);
  }, []);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  const api = useMemo(() => ({ setDirty }), [setDirty]);
  const guardDialog = (
    <ConfirmDialog
      open={pending !== null}
      title={t('sec.settings.leave.title')}
      message={t('sec.settings.leave.message')}
      confirmLabel={t('sec.settings.leave.confirm')}
      danger
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const go = pending;
        setPending(null);
        setDirtyTabs({});
        anyDirtyRef.current = false;
        go?.();
      }}
    />
  );
  return { dirtyTabs, api, guardDialog };
}

export function SettingsGroup({ title, icon, actions, status, children, id }: {
  title: string; icon?: ReactNode; actions?: ReactNode; status?: ReactNode; children: ReactNode; id?: string;
}) {
  const heading = useId();
  return (
    <Card as="section" className="ec-set-group" aria-labelledby={heading} id={id}>
      <header className="ec-set-group-head">
        {icon ? <span className="ec-set-group-icon" aria-hidden="true">{icon}</span> : null}
        <h3 id={heading}>{title}</h3>
        {status ? <span className="ec-set-group-status">{status}</span> : null}
        <span className="ec-set-spacer" />
        {actions}
      </header>
      <div className="ec-set-rows">{children}</div>
    </Card>
  );
}

export type EffectKind = 'instant' | 'restart' | 'next-start' | 'remote-host';
const EFFECT_KEYS: Record<EffectKind, MessageKey> = {
  instant: 'sec.settings.effect.instant',
  restart: 'sec.settings.effect.restart',
  'next-start': 'sec.settings.effect.nextStart',
  'remote-host': 'sec.settings.effect.remoteHost',
};

export function SettingRow({ label, hint, effect, icon, htmlFor, children, error, stacked }: {
  label: string; hint?: string; effect?: EffectKind; icon?: ReactNode; htmlFor?: string; children: ReactNode; error?: string; stacked?: boolean;
}) {
  const { t } = useI18n();
  const remote = useCoreRuntime().status?.connectionMode === 'remote';
  // Restarts happen on the remote host in Remote mode, not on this computer.
  const shown: EffectKind | undefined = remote && (effect === 'restart' || effect === 'next-start') ? 'remote-host' : effect;
  return (
    <div className={`ec-set-row${stacked ? ' is-stacked' : ''}${error ? ' has-error' : ''}`}>
      <div className="ec-set-row-label">
        {icon ? <span className="ec-set-row-icon" aria-hidden="true">{icon}</span> : null}
        <label htmlFor={htmlFor}>{label}</label>
        {hint ? <span className="ec-set-hint" title={hint} tabIndex={0} role="img" aria-label={hint}><Info size={13} aria-hidden="true" /></span> : null}
        {shown ? <Chip size="sm" tone={shown === 'instant' ? 'ok' : 'outline'}>{t(EFFECT_KEYS[shown])}</Chip> : null}
      </div>
      <div className="ec-set-row-control">{children}</div>
      {error ? <p className="ec-set-row-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Sticky unsaved-changes bar. `count` = changed fields (0 hides the bar unless `saved` is set). */
export function SaveBar({ count, busy, onSave, onDiscard, error, saved, saveLabel, disabled }: {
  count: number; busy?: boolean; onSave: () => void; onDiscard: () => void; error?: string; saved?: boolean; saveLabel?: string; disabled?: boolean;
}) {
  const { t } = useI18n();
  if (count === 0 && !saved && !error) return null;
  return (
    <div className={`ec-set-savebar${count > 0 ? ' is-dirty' : ''}`} role="region" aria-label={t('sec.settings.save.region')}>
      <span className="ec-set-savebar-text" role="status">
        {count > 0
          ? t('sec.settings.save.unsaved', { count })
          : <><Check size={14} aria-hidden="true" /> {t('sec.settings.save.saved')}</>}
      </span>
      {error ? <span className="ec-set-savebar-error" role="alert">{error}</span> : null}
      <span className="ec-set-spacer" />
      {count > 0 ? <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} disabled={busy} onClick={onDiscard}>{t('sec.settings.save.discard')}</Button> : null}
      {count > 0 ? <Button size="sm" variant="primary" loading={busy} disabled={disabled} onClick={onSave}>{saveLabel ?? t('common.save')}</Button> : null}
    </div>
  );
}

/** Small helper for numeric/text drafts: keeps raw string, reports dirty vs saved value. */
export function useDraft<T>(saved: T | null | undefined, equals: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b)) {
  const [draft, setDraft] = useState<T | null>(saved ?? null);
  const savedRef = useRef(saved);
  useEffect(() => {
    // Adopt a new saved value unless the user is mid-edit on a differing draft.
    setDraft((current) => (current === null || (savedRef.current != null && equals(current, savedRef.current)) ? saved ?? null : current));
    savedRef.current = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const dirty = draft !== null && saved != null && !equals(draft, saved);
  const reset = useCallback(() => setDraft(saved ?? null), [saved]);
  return { draft, setDraft, dirty, reset };
}
