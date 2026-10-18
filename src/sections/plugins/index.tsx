import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { PluginsPage } from '../../pages/PluginsPage';
import { pluginsSubs } from './subs';
import './plugins.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function PluginsSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="plugins" titleKey="shell.nav.plugins" subs={pluginsSubs} sub={sub}>
      {<PluginsPage />}
    </LegacyHost>
  );
}
