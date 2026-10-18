import { Sprout, Shapes } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { EasyModePage } from '../pages/EasyModePage';
import { useI18n } from '../i18n';
import { Button } from '../ui';
import { PageHeader } from './PageHeader';
import { navigate } from './router';
import './easy.css';
import type { SectionRoute } from './types';

const KitGallery = lazy(() => import('../ui/KitGallery'));

/**
 * Guided setup (upstream's Beginner Mode): the two-step sign-in + agent wizard, kept for its one-click flow and
 * interactive guide. Local mode only (Shell redirects remote). Reached from Overview's Get started card.
 */
function EasyPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader
        title={t('shell.easyMode')}
        actions={<Button size="sm" variant="secondary" onClick={() => navigate('/overview')}>{t('easyMode.exit')}</Button>}
      />
      <div className="ec-page-body ec-easy">
        <EasyModePage inShell onExit={() => navigate('/overview')} />
      </div>
    </>
  );
}

export const easyRoute: SectionRoute = {
  id: 'easy', labelKey: 'shell.easyMode', icon: Sprout, group: 'hidden', alwaysAvailable: true, Page: EasyPage,
};

function KitPage() {
  return <Suspense fallback={null}><KitGallery /></Suspense>;
}

/** Dev/reference gallery of every kit component. Hidden from nav; open `#/kit`. */
export const kitRoute: SectionRoute = {
  id: 'kit', labelKey: 'shell.nav.overview', icon: Shapes, group: 'hidden', alwaysAvailable: true, Page: KitPage,
};
