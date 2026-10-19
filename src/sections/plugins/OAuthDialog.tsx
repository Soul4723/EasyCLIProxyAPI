import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '../../services/documentTarget';
import { CheckCircle2, Copy, ExternalLink, LoaderCircle, LogIn } from 'lucide-react';
import { useCoreRuntime } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { pluginOAuthText, type PluginOAuthMessage } from '../../i18n/pluginOAuth';
import { usePrivacyMask } from '../../privacy';
import { startSessionPolling } from '../../services/sessionPolling';
import { managementApi } from '../../services/managementApi';
import type { PluginListEntry } from '../../services/plugins';
import { Button, Dialog, Masked } from '../../ui';
import { Banner, Scope } from './parts';

type OAuthStart = { url: string; state?: string | null; userCode?: string | null; flow?: string | null; expiresIn?: number | null };
type OAuthStatus = { status: string; error?: string | null };
type Session = { state: string; url: string; code: string; device: boolean; expires: number };
type Phase = 'starting' | 'waiting' | 'success' | 'error';
const MAX_SESSION_MS = 30 * 60 * 1000;

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

/**
 * Plugin OAuth sign-in (the old PluginOAuthDialog, same commands: start_oauth_login / get_oauth_status / open_oauth_url /
 * submit_oauth_callback, cancelling the session on close): link + open/copy, device code, manual callback paste, expiry.
 * Props: plugin (must declare an OAuth provider and be effectively enabled), browser?, onClose, onCompleted.
 */
export function OAuthDialog({ plugin, browser = 'default', onClose, onCompleted }: {
  plugin: PluginListEntry;
  browser?: string;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const { t, locale, formatDate } = useI18n();
  const { status: coreStatus } = useCoreRuntime();
  const text = (key: PluginOAuthMessage) => pluginOAuthText(key, locale);
  const mask = usePrivacyMask();
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhaseState] = useState<Phase>('starting');
  const phaseRef = useRef<Phase>('starting');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [callback, setCallback] = useState('');
  const [callbackInvalid, setCallbackInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState(false);
  const callbackPending = useRef(false);
  const openPending = useRef(false);
  const generation = useRef(0);
  const dismiss = useRef<() => void>(() => {});
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const setPhase = (value: Phase) => { phaseRef.current = value; setPhaseState(value); };
  const close = () => { dismiss.current(); onClose(); };
  const provider = plugin.oauthProvider?.trim() ?? '';

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    let terminal = false;
    let completed = false;
    let state = '';
    let stopPolling = () => {};
    let expiryTimer: number | undefined;
    const cancelled = new Set<string>();
    const translate = (key: PluginOAuthMessage) => pluginOAuthText(key, localeRef.current);
    const current = () => active && !terminal && generation.current === currentGeneration;
    const clearTimers = () => { stopPolling(); window.clearTimeout(expiryTimer); };
    const cancel = (value: string) => {
      if (!value || cancelled.has(value)) return;
      cancelled.add(value);
      void managementApi.delete('/oauth/session', { query: { state: value } }).catch(() => {});
    };
    const stop = () => {
      if (!active) return;
      active = false;
      generation.current += 1;
      clearTimers();
      if (!completed) cancel(state);
    };
    dismiss.current = stop;
    setPhase('starting'); setSession(null); setError(''); setNotice(''); setCallback('');
    setCallbackInvalid(false); setSubmitting(false); setOpening(false);
    callbackPending.current = false; openPending.current = false;
    const fail = (reason: string) => {
      if (!current()) return;
      terminal = true; clearTimers(); setPhase('error'); setError(reason);
      setSubmitting(false); setOpening(false); cancel(state);
    };
    if (!plugin.supportsOAuth || !plugin.effectiveEnabled || !provider) {
      fail(translate('unavailable'));
      return stop;
    }
    const poll = async () => {
      if (!current()) return;
      try {
        const result = await invoke<OAuthStatus>('get_oauth_status', { state });
        if (!current()) return;
        if (result.status === 'ok') {
          completed = true; terminal = true; clearTimers(); setPhase('success');
          setCallback(''); setNotice(''); setError(''); setSubmitting(false); setOpening(false);
          completedRef.current();
        } else if (result.status === 'error') fail(result.error || translate('failed'));
        else if (result.status !== 'wait') fail(translate('failed'));
      } catch (reason) { fail(message(reason)); }
    };
    void invoke<OAuthStart>('start_oauth_login', { provider, browser: 'none', pluginProvider: true }).then(result => {
      const returnedState = result.state?.trim() ?? '';
      if (!current()) { cancel(returnedState); return; }
      state = returnedState;
      if (!state) { fail(translate('missingState')); return; }
      try {
        const url = new URL(result.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { fail(translate('invalidUrl')); return; }
      const duration = typeof result.expiresIn === 'number' && Number.isFinite(result.expiresIn) && result.expiresIn > 0
        ? Math.min(result.expiresIn * 1000, MAX_SESSION_MS) : MAX_SESSION_MS;
      const nextSession: Session = { state, url: result.url, code: result.userCode?.trim() ?? '', device: result.flow?.toLowerCase() === 'device' || Boolean(result.userCode), expires: Date.now() + duration };
      setSession(nextSession); setPhase('waiting');
      expiryTimer = window.setTimeout(() => fail(translate('expired')), duration);
      stopPolling = startSessionPolling({ intervalMs: 3000, check: async () => { await poll(); return current(); }, onError: reason => fail(message(reason)) });
    }).catch(reason => fail(message(reason)));
    return stop;
  }, [provider, plugin.supportsOAuth, plugin.effectiveEnabled, attempt]);

  const activeSession = () => Boolean(session && phaseRef.current === 'waiting' && Date.now() < session.expires);
  const copy = async (value: string) => {
    const current = generation.current;
    try { await navigator.clipboard.writeText(value); if (generation.current === current) setNotice(text('copied')); }
    catch (reason) { if (generation.current === current) setError(message(reason)); }
  };
  const open = async () => {
    if (!session || !activeSession() || openPending.current) return;
    const current = generation.current;
    openPending.current = true; setOpening(true); setError('');
    try { await invoke('open_oauth_url', { url: session.url, browser }); }
    catch (reason) { if (generation.current === current && phaseRef.current === 'waiting') setError(message(reason)); }
    finally { if (generation.current === current) { openPending.current = false; setOpening(false); } }
  };
  const submit = async () => {
    if (!session || !activeSession() || callbackPending.current) return;
    const redirectUrl = callback.trim();
    try {
      const url = new URL(redirectUrl);
      if (url.searchParams.get('state') !== session.state || !(url.searchParams.get('code')?.trim() || url.searchParams.get('error')?.trim() || url.searchParams.get('error_description')?.trim())) throw new Error();
    } catch { setCallbackInvalid(true); setError(text('callbackInvalid')); return; }
    const current = generation.current;
    callbackPending.current = true; setSubmitting(true); setCallbackInvalid(false); setError(''); setNotice('');
    try {
      await invoke('submit_oauth_callback', { provider, redirectUrl, pluginProvider: true });
      if (generation.current === current && phaseRef.current === 'waiting') setNotice(text('submitted'));
    } catch (reason) { if (generation.current === current && phaseRef.current === 'waiting') setError(message(reason)); }
    finally { if (generation.current === current) { callbackPending.current = false; setSubmitting(false); } }
  };

  return (
    <Dialog open onClose={close} size="md"
      title={<Scope><span className="pl-dialog-title"><LogIn size={16} aria-hidden />{text('title')}<Masked value={plugin.metadata?.name || plugin.id} className="pl-muted" /></span></Scope>}
      footer={<>
        <Button variant="secondary" onClick={close}>{t(phase === 'success' || phase === 'error' ? 'common.close' : 'common.cancel')}</Button>
        {phase === 'error' ? <Button variant="primary" onClick={() => setAttempt(value => value + 1)}>{text('retry')}</Button> : null}
      </>}>
      <Scope><div className="pl-form pl-oauth">
        {coreStatus?.connectionMode === 'remote' ? <Banner tone="info">{t('connection.oauthHint')}</Banner> : null}
        <p className={`pl-oauth-status pl-oauth-status--${phase}`} role="status">
          {phase === 'starting' || phase === 'waiting' ? <LoaderCircle size={16} className="pl-spin" aria-hidden /> : phase === 'success' ? <CheckCircle2 size={16} aria-hidden /> : null}
          {text(phase === 'error' ? 'failed' : phase)}
        </p>
        {session && phase === 'waiting' ? <>
          <div className="pl-field">
            <label className="pl-field-label" htmlFor={`${id}-link`}>{text('link')}</label>
            <textarea id={`${id}-link`} className="pl-input pl-input--mono pl-textarea" rows={3} readOnly value={mask.text(session.url)} spellCheck={false} />
          </div>
          <div className="pl-oauth-actions">
            <Button variant="primary" loading={opening} icon={<ExternalLink size={14} />} onClick={() => void open()}>{text('open')}</Button>
            <Button variant="secondary" icon={<Copy size={14} />} onClick={() => void copy(session.url)}>{text('copy')}</Button>
          </div>
          {session.code ? <div className="pl-oauth-code">
            <span className="pl-field-label">{text('code')}</span>
            <strong className="pl-oauth-code-value">{session.code}</strong>
            <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy(session.code)}>{text('copyCode')}</Button>
            <small className="pl-field-hint">{text('deviceHint')}</small>
          </div> : null}
          {!session.device ? <form className="pl-field" onSubmit={event => { event.preventDefault(); void submit(); }} noValidate>
            <label className="pl-field-label" htmlFor={`${id}-callback`}>{text('callback')}</label>
            <input id={`${id}-callback`} className="pl-input pl-input--mono" type="url" value={callback} disabled={submitting} autoComplete="off" spellCheck={false}
              aria-invalid={callbackInvalid} onChange={event => { setCallback(event.currentTarget.value); setCallbackInvalid(false); setError(''); setNotice(''); }} />
            <small className="pl-field-hint">{text('callbackHint')}</small>
            <div><Button type="submit" variant="secondary" loading={submitting} disabled={!callback.trim()}>{text(submitting ? 'submitting' : 'submit')}</Button></div>
          </form> : null}
          <small className="pl-field-hint">{text('expires')} {formatDate(session.expires, { hour: '2-digit', minute: '2-digit' })}</small>
        </> : null}
        {error ? <Banner tone="error"><Masked value={error} /></Banner> : null}
        {notice ? <Banner tone="success">{notice}</Banner> : null}
      </div></Scope>
    </Dialog>
  );
}
