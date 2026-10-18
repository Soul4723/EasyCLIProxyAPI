import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { PageHeader } from './PageHeader';
import { RouteTabs } from './RouteTabs';
import type { SectionSub } from './types';
import './LegacyHost.css';

/**
 * Temporary wrapper: renders a not-yet-rebuilt page component inside the new shell (new header + sub tabs,
 * old page body in the old `.workspace/.content` layout). A section removes its LegacyHost use when it
 * ships its own page; delete this file when no section uses it.
 */
export function LegacyHost({ page, titleKey, subs, sub, actions, children }: {
  page: string;
  titleKey: MessageKey;
  subs?: readonly SectionSub[];
  sub?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="ec-legacy" data-legacy-page={page}>
      <PageHeader
        title={t(titleKey)}
        actions={actions}
        tabs={subs && subs.length > 1
          ? <RouteTabs page={page} subs={subs} active={sub ?? subs[0].id} ariaLabel={t(titleKey)} />
          : undefined}
      />
      <div className="app-shell ec-legacy-shell">
        <div className="workspace ec-legacy-workspace">
          <main className="content">{children}</main>
        </div>
      </div>
    </div>
  );
}
