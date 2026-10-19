import { Shapes } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { SectionRoute } from './types';

const KitGallery = lazy(() => import('../ui/KitGallery'));

function KitPage() {
  return <Suspense fallback={null}><KitGallery /></Suspense>;
}

/** Dev/reference gallery of every kit component. Hidden from nav; open `#/kit`. */
export const kitRoute: SectionRoute = {
  id: 'kit', labelKey: 'shell.nav.overview', icon: Shapes, group: 'hidden', alwaysAvailable: true, Page: KitPage,
};
