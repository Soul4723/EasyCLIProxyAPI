import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { ConfigPanelPage } from '../../pages/ConfigPanel';
import { VersionManagementPage } from '../../pages/VersionManagementPage';
import { settingsSubs } from './subs';
import './settings.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function SettingsSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="settings" titleKey="shell.nav.settings" subs={settingsSubs} sub={sub}>
      {sub === 'updates' ? <VersionManagementPage /> : <ConfigPanelPage />}
    </LegacyHost>
  );
}
