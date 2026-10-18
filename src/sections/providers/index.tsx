import { Suspense, lazy, useMemo } from 'react';
import type { SectionPageProps } from '../../shell/types';
import { ProvidersPage } from './ProvidersPage';
import './providers.css';

// Dev-only test harness: `#/providers?preview=creds` renders `creds/Preview.tsx` (mock states for the credential UI tests). Not in production builds.
const previews = (import.meta.env.DEV ? import.meta.glob('./*/Preview.tsx') : {}) as Record<string, () => Promise<{ default: React.ComponentType }>>;

export function ProvidersSection(props: SectionPageProps) {
  const previewName = props.params.get('preview');
  const Preview = useMemo(() => {
    const loader = previewName ? previews[`./${previewName}/Preview.tsx`] : undefined;
    return loader ? lazy(loader) : null;
  }, [previewName]);
  if (Preview) return <div className="ec-sec-providers"><Suspense fallback={null}><Preview /></Suspense></div>;
  return <ProvidersPage {...props} />;
}
