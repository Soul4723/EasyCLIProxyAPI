import type { ReactNode } from 'react';
import { Box, CircleAlert, CircleCheck, Info, KeyRound, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pluginText } from '../../i18n/plugins';
import { openSettingField } from '../../services/settingsNavigation';
import { Button, IconButton, StatusPill, type CredentialStatus } from '../../ui';
import type { PluginStatusKey } from './usePlugins';

export const isGitHubRateLimit = (message: string) => /plugin_store_rate_limited|GitHub API rate limited/i.test(message);

const PILL: Record<PluginStatusKey, CredentialStatus> = {
  active: 'available', inactive: 'disabled', globalDisabled: 'disabled', missingFile: 'error', notLoaded: 'limited',
};

/** Portal content (dialogs, side panels) renders outside the section root; wrap it so the section CSS still applies. */
export function Scope({ children }: { children: ReactNode }) {
  return <span className="ec-sec-plugins pl-scope">{children}</span>;
}

/** Icon tile used by installed rows, store cards and dialogs. `dim` greys it for disabled plugins. */
export function PluginTile({ dim = false, size = 36 }: { dim?: boolean; size?: number }) {
  return (
    <span className={`pl-tile${dim ? ' pl-tile--dim' : ''}`} style={{ width: size, height: size }} aria-hidden>
      <Box size={Math.round(size * 0.5)} />
    </span>
  );
}

/** Plugin runtime status as a StatusPill; the long hint (missing file, not loaded) rides on the tooltip. */
export function PluginStatus({ status, hint }: { status: PluginStatusKey; hint?: string }) {
  const { locale } = useI18n();
  return (
    <span className="pl-status" title={hint}>
      <StatusPill status={PILL[status]} label={pluginText(status, locale)} size="sm" />
    </span>
  );
}

/** Rate-limit hint with the shortcut to the GitHub token setting (old GitHubTokenHint). */
export function GitHubTokenHint() {
  const { locale } = useI18n();
  return (
    <span className="pl-rate">
      <span>{pluginText('rateLimitHint', locale)}</span>
      <Button size="xs" variant="outline" icon={<KeyRound size={12} />} onClick={() => openSettingField(['server', 'github-token'])}>
        {pluginText('configureToken', locale)}
      </Button>
    </span>
  );
}

/** One-line banner (error / warn / info / success) with an optional action and dismiss. */
export function Banner({ tone, children, action, onDismiss, dismissLabel }: {
  tone: 'error' | 'warn' | 'info' | 'success';
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warn' ? TriangleAlert : tone === 'success' ? CircleCheck : Info;
  return (
    <div className={`pl-banner pl-banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={14} aria-hidden />
      <span className="pl-banner-text">{children}</span>
      {action}
      {onDismiss ? <IconButton size="xs" label={dismissLabel ?? ''} icon={<X size={12} />} onClick={onDismiss} /> : null}
    </div>
  );
}
