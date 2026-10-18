import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { ApiAccessPage } from '../../pages/ApiAccessPage';
import { OAuthManagementPage } from '../../pages/ManagementPages';
import { providersSubs } from './subs';
import './providers.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function ProvidersSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="providers" titleKey="shell.nav.providers" subs={providersSubs} sub={sub}>
      {sub === 'oauth' ? <OAuthManagementPage /> : <ApiAccessPage />}
    </LegacyHost>
  );
}
