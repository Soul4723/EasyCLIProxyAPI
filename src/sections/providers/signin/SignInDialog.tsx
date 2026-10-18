/**
 * SignInDialog: the one sign-in surface for built-in OAuth providers and plugin OAuth providers (CPAMC-style numbered
 * steps in the kit Dialog). Rendered once through `controller.dialogs`; it shows `controller.session`.
 *
 *  1 Open the authorization page   host highlighted, copy, open button, skeleton while the link is generated, refresh
 *  2 Enter the device code         only for device flows (copy)
 *  3 Paste the callback URL        only when the provider supports it; optional locally, the primary path on a remote core
 * Footer status bar: generating / waiting / failed. Success view links to the provider's accounts.
 */
import { useId } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { routeHref } from '../../../shell/router';
import { Button, Chip, CopyButton, Dialog, ProviderLogo, Skeleton, cx } from '../../../ui';
import { BrowserPicker } from './BrowserPicker';
import { splitAuthUrl } from './logic';
import type { SignInDialogController, SignInSession } from './types';
import './signin.css';

export function SignInDialog({ controller }: { controller: SignInDialogController }) {
  const { t } = useI18n();
  const session = controller.session;
  if (!session) return null;
  const { provider, flow } = session;
  const view = flow.status === 'success' ? 'success' : flow.status === 'error' ? 'failed' : 'flow';

  return (
    <Dialog
      open
      onClose={session.close}
      size="md"
      title={(
        <span className="ec-signin-title">
          <ProviderLogo provider={provider.brand} size={24} />
          <span>{t('sec.providers.signin.title', { provider: provider.name })}</span>
        </span>
      )}
      footer={view === 'flow'
        ? <FlowFooter session={session} />
        : view === 'failed'
          ? <FailedFooter session={session} />
          : <SuccessFooter session={session} />}
    >
      {view === 'success'
        ? <SuccessBody session={session} />
        : view === 'failed'
          ? <FailedBody session={session} />
          : <FlowBody controller={controller} session={session} />}
    </Dialog>
  );
}

function Note({ tone = 'info', children, role }: { tone?: 'info' | 'warn' | 'error'; children: string; role?: 'alert' | 'status' }) {
  return (
    <p className={cx('ec-signin-note', tone !== 'info' && `ec-signin-note--${tone}`)} role={role}>
      {tone === 'info' ? <Info aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

function Step({ title, titleFor, optional, primary, children }: {
  title: string;
  titleFor?: string;
  optional?: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className={cx('ec-signin-step', primary && 'ec-signin-step--primary')}>
      <div className="ec-signin-step__body">
        <div className="ec-signin-step__head">
          {titleFor
            ? <label className="ec-signin-step__title" htmlFor={titleFor}>{title}</label>
            : <span className="ec-signin-step__title">{title}</span>}
          {optional ? <Chip size="sm">{t('sec.providers.signin.optional')}</Chip> : null}
        </div>
        {children}
      </div>
    </li>
  );
}

function FlowBody({ controller, session }: { controller: SignInDialogController; session: SignInSession }) {
  const { t, formatDate } = useI18n();
  const privacy = usePrivacyMask();
  const { provider, flow } = session;
  const url = flow.url;
  const parts = url ? splitAuthUrl(url) : null;
  const callbackId = useId();
  const feedbackId = useId();
  const showCallback = provider.callbackSupported && !flow.device && Boolean(url);
  const remoteCallbackFirst = controller.remote && showCallback;
  const xai = provider.id === 'xai';
  const hint = xai ? 'sec.providers.signin.callback.hintXai'
    : provider.id === 'devin' ? 'sec.providers.signin.callback.hintDevin'
      : 'sec.providers.signin.callback.hint';
  const feedback = flow.callbackStatus === 'error'
    ? { tone: 'error' as const, text: flow.callbackError ?? '' }
    : flow.callbackStatus === 'success'
      ? { tone: 'ok' as const, text: t('sec.providers.signin.callback.ok') }
      : null;

  return (
    <div className="ec-signin-body">
      {controller.remote ? (
        <Note>{t(provider.callbackSupported && !flow.device
          ? 'sec.providers.signin.remote.callback' : 'sec.providers.signin.remote.noCallback')}</Note>
      ) : null}
      <BrowserPicker controller={controller} />
      {flow.notice ? (
        <Note tone={flow.notice.tone === 'error' ? 'error' : 'info'} role={flow.notice.tone === 'error' ? 'alert' : 'status'}>
          {privacy.text(flow.notice.text)}
        </Note>
      ) : null}
      <ol className="ec-signin-steps">
        <Step title={t('sec.providers.signin.step.open')} primary={!remoteCallbackFirst}>
          <div className="ec-signin-url" aria-busy={!url}>
            {parts && url ? (
              <>
                <span className="ec-signin-url__text" title={privacy.text(url)}>
                  <span>{parts.scheme}</span>
                  <span className="ec-signin-url__host">{parts.host}</span>
                  <span>{privacy.enabled ? '/…' : parts.rest}</span>
                </span>
                <CopyButton value={url} size="sm" />
              </>
            ) : (
              <span className="ec-signin-url__skeleton" aria-label={t('sec.providers.signin.generating')}>
                <Skeleton height={12} width="70%" />
              </span>
            )}
          </div>
          <div className="ec-signin-actions">
            <Button
              variant={remoteCallbackFirst ? 'secondary' : 'primary'}
              size="sm"
              icon={<ExternalLink />}
              disabled={!url}
              onClick={session.openLink}
            >
              {t('sec.providers.signin.link.open')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw />}
              disabled={!url || flow.refreshing}
              loading={flow.refreshing}
              onClick={session.refreshLink}
            >
              {t(flow.refreshing ? 'sec.providers.signin.link.refreshing' : 'sec.providers.signin.link.refresh')}
            </Button>
          </div>
          {flow.expiresAt ? (
            <span className="ec-signin-expiry">
              {t('sec.providers.signin.expires', { time: formatDate(flow.expiresAt, { hour: '2-digit', minute: '2-digit' }) })}
            </span>
          ) : null}
        </Step>
        {flow.userCode ? (
          <Step title={t('sec.providers.signin.step.code')}>
            <div className="ec-signin-code">
              <output className="ec-signin-code__value" aria-label={t('sec.providers.signin.code.label')}>
                {flow.userCode}
              </output>
              <CopyButton value={flow.userCode} label={t('sec.providers.signin.code.copy')} variant="outline" size="sm" />
            </div>
          </Step>
        ) : null}
        {showCallback ? (
          <Step
            title={t('sec.providers.signin.step.callback')}
            titleFor={callbackId}
            optional={!controller.remote}
            primary={remoteCallbackFirst}
          >
            <p className="ec-signin-step__hint">{t(hint)}</p>
            <form
              className="ec-signin-callback"
              onSubmit={(event) => {
                event.preventDefault();
                session.submitCallback();
              }}
            >
              <input
                id={callbackId}
                className="ec-signin-input"
                value={flow.callbackUrl ?? ''}
                onChange={(event) => session.setCallbackUrl(event.currentTarget.value)}
                placeholder={t(xai
                  ? 'sec.providers.signin.callback.placeholderXai' : 'sec.providers.signin.callback.placeholder')}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={feedback?.tone === 'error'}
                aria-describedby={feedback ? feedbackId : undefined}
              />
              <Button
                type="submit"
                variant={remoteCallbackFirst ? 'primary' : 'secondary'}
                loading={flow.callbackSubmitting}
                disabled={!flow.callbackUrl?.trim()}
              >
                {t('sec.providers.signin.callback.submit')}
              </Button>
            </form>
            {feedback ? (
              <p
                id={feedbackId}
                className={cx('ec-signin-feedback', `ec-signin-feedback--${feedback.tone}`)}
                role={feedback.tone === 'error' ? 'alert' : 'status'}
              >
                {privacy.text(feedback.text)}
              </p>
            ) : null}
          </Step>
        ) : null}
      </ol>
    </div>
  );
}

function FlowFooter({ session }: { session: SignInSession }) {
  const { t } = useI18n();
  const { provider, flow } = session;
  const generating = !flow.url;
  return (
    <div className="ec-signin-foot">
      <p className="ec-signin-status" role="status" aria-live="polite">
        {generating
          ? <LoaderCircle className="ec-signin-spin" aria-hidden="true" />
          : <span className="ec-signin-status__dot" aria-hidden="true" />}
        <span className="ec-signin-status__text">
          {t(generating ? 'sec.providers.signin.generating' : 'sec.providers.signin.status.waiting')}
          {!generating && provider.kind !== 'plugin' ? (
            <>
              <br />
              <span className="ec-muted">{t('sec.providers.signin.status.background')}</span>
            </>
          ) : null}
        </span>
      </p>
      <div className="ec-signin-foot__actions">
        <Button onClick={session.close}>{t(provider.kind === 'plugin' ? 'common.cancel' : 'common.close')}</Button>
      </div>
    </div>
  );
}

function FailedBody({ session }: { session: SignInSession }) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  return (
    <div className="ec-signin-body">
      <p className="ec-signin-note ec-signin-note--error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span>
          <strong>{t('sec.providers.signin.status.failed')}</strong>
          {session.flow.error ? <><br />{privacy.text(session.flow.error)}</> : null}
        </span>
      </p>
    </div>
  );
}

function FailedFooter({ session }: { session: SignInSession }) {
  const { t } = useI18n();
  return (
    <>
      <Button onClick={session.close}>{t('common.close')}</Button>
      <Button variant="primary" icon={<RefreshCw />} onClick={session.restart}>{t('sec.providers.signin.retry')}</Button>
    </>
  );
}

function SuccessBody({ session }: { session: SignInSession }) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const { provider, flow } = session;
  return (
    <div className="ec-signin-result" role="status">
      <span className="ec-signin-result__mark"><CircleCheck aria-hidden="true" /></span>
      <h3 className="ec-signin-result__title">{t('sec.providers.signin.success.title', { provider: provider.name })}</h3>
      <p className="ec-signin-result__sub">{t('sec.providers.signin.success.saved')}</p>
      {flow.priorityError ? (
        <Note tone="warn" role="alert">
          {t('sec.providers.signin.success.priorityFailed', { error: privacy.text(flow.priorityError) })}
        </Note>
      ) : null}
    </div>
  );
}

function SuccessFooter({ session }: { session: SignInSession }) {
  const { t } = useI18n();
  const { provider } = session;
  return (
    <>
      <Button onClick={session.close}>{t('common.close')}</Button>
      <a
        className="ec-btn ec-btn--secondary ec-btn--md"
        href={routeHref('providers', null, { p: provider.brand })}
        onClick={session.close}
      >
        {t('sec.providers.signin.success.view')}
      </a>
      <Button variant="primary" onClick={session.restart}>{t('sec.providers.signin.success.another')}</Button>
    </>
  );
}
