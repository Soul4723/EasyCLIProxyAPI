import { Suspense, lazy, useMemo } from 'react';
import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { ApiAccessPage } from '../../pages/ApiAccessPage';
import { OAuthManagementPage } from '../../pages/ManagementPages';
import { providersSubs } from './subs';
import './providers.css';

// Dev-only preview hook while the page is being assembled: `#/providers?preview=api|creds|signin` renders
// `src/sections/providers/<name>/Preview.tsx` (default export). Removed once the real page lands.
const previews = import.meta.glob('./*/Preview.tsx') as Record<string, () => Promise<{ default: React.ComponentType }>>;

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function ProvidersSection({ sub, params }: SectionPageProps) {
  const previewName = params.get('preview');
  const Preview = useMemo(() => {
    const loader = previewName ? previews[`./${previewName}/Preview.tsx`] : undefined;
    return loader ? lazy(loader) : null;
  }, [previewName]);
  if (Preview) {
    return <div className="ec-sec-providers"><Suspense fallback={null}><Preview /></Suspense></div>;
  }

  return (
    <LegacyHost page="providers" titleKey="shell.nav.providers" subs={providersSubs} sub={sub}>
      {sub === 'oauth' ? <OAuthManagementPage /> : <ApiAccessPage />}
    </LegacyHost>
  );
}
