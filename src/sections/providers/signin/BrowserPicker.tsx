/**
 * BrowserPicker: which browser a sign-in link opens in ("do not open automatically" included). The choice is
 * remembered (OAUTH_BROWSER_STORAGE_KEY). On a remote core nothing is opened automatically, so the control is
 * disabled and says why.
 *
 * Props: controller (the browser fields of OAuthSignInController), className.
 */
import { useId } from 'react';
import { useI18n } from '../../../i18n';
import { cx } from '../../../ui';
import { NO_AUTO_OPEN_BROWSER_ID } from './logic';
import type { OAuthSignInController } from './types';
import './signin.css';

export type BrowserPickerProps = {
  controller: Pick<OAuthSignInController, 'browsers' | 'browsersLoading' | 'selectedBrowser' | 'setBrowser' | 'remote'>;
  className?: string;
};

export function BrowserPicker({ controller, className }: BrowserPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const { browsers, browsersLoading, selectedBrowser, setBrowser, remote } = controller;
  const reason = remote ? t('sec.providers.signin.browser.remoteReason') : '';

  return (
    <div className={cx('ec-signin-picker', className)}>
      <label className="ec-signin-picker__label" htmlFor={id}>{t('sec.providers.signin.browser.label')}</label>
      <select
        id={id}
        className="ec-signin-select"
        value={remote ? NO_AUTO_OPEN_BROWSER_ID : selectedBrowser}
        onChange={(event) => setBrowser(event.currentTarget.value)}
        disabled={browsersLoading || remote}
        title={reason || undefined}
        aria-describedby={reason ? `${id}-reason` : undefined}
      >
        {browsersLoading ? <option value="">{t('sec.providers.signin.browser.detecting')}</option> : null}
        {browsers.map((browser) => (
          <option value={browser.id} key={browser.id}>
            {browser.id === 'default' ? t('sec.providers.signin.browser.systemDefault') : browser.label}
          </option>
        ))}
        <option value={NO_AUTO_OPEN_BROWSER_ID}>{t('sec.providers.signin.browser.noAutoOpen')}</option>
      </select>
      {reason ? <span id={`${id}-reason`} className="ec-signin-picker__reason">{reason}</span> : null}
    </div>
  );
}
