import type { ReactNode } from 'react';
import { Eye, EyeOff, Menu } from 'lucide-react';
import { useI18n } from '../i18n';
import { usePrivacyMode } from '../privacy';
import { Badge } from '../ui/Chip';
import { IconButton } from '../ui/IconButton';
import { useShell } from './ShellContext';
import './PageHeader.css';

/**
 * Sticky header every page renders first: title (+ count), page actions, sub-page tabs and the privacy eye.
 * `tabs` is the sub-page row (use <RouteTabs/>); `actions` are page-level buttons placed before the eye.
 */
export function PageHeader({ title, count, actions, tabs, children }: {
  title: string;
  count?: number;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** Extra left-hand content after the title (e.g. a StatusPill). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { openMenu } = useShell();
  const [privacy, setPrivacy] = usePrivacyMode();
  return (
    <header className="ec-page-header">
      <div className="ec-page-header-row">
        <IconButton className="ec-page-menu" label={t('shell.menu.open')} icon={<Menu size={16} />} onClick={openMenu} />
        <h1 className="ec-page-title">{title}</h1>
        {count !== undefined ? <Badge>{count}</Badge> : null}
        {children}
        <span className="ec-page-header-spacer" />
        <div className="ec-page-actions">{actions}</div>
        <IconButton
          label={t(privacy ? 'app.privacy.disable' : 'app.privacy.enable')}
          icon={privacy ? <EyeOff size={16} /> : <Eye size={16} />}
          active={privacy}
          aria-pressed={privacy}
          data-testid="privacy-toggle"
          onClick={() => setPrivacy(!privacy)}
        />
      </div>
      {tabs ? <div className="ec-page-header-tabs">{tabs}</div> : null}
    </header>
  );
}
