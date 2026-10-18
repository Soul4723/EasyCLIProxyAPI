import { Sprout, Shapes } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { EasyModePage } from '../pages/EasyModePage';
import { useI18n } from '../i18n';
import { useThemePreference } from '../theme';
import { navigate } from './router';
import type { SectionRoute } from './types';

const KitGallery = lazy(() => import('../ui/KitGallery'));

/** Temporary full-screen Easy mode (the Overview section replaces it with first-run onboarding). */
function EasyPage() {
  const { locale, setLocale } = useI18n();
  const [theme, setTheme] = useThemePreference();
  return (
    <EasyModePage onExit={() => navigate('/overview')} theme={theme} setTheme={setTheme} locale={locale} setLocale={setLocale} />
  );
}

export const easyRoute: SectionRoute = {
  id: 'easy', labelKey: 'shell.easyMode', icon: Sprout, group: 'hidden', alwaysAvailable: true, bare: true, Page: EasyPage,
};

function KitPage() {
  return <Suspense fallback={null}><KitGallery /></Suspense>;
}

/** Dev/reference gallery of every kit component. Hidden from nav; open `#/kit`. */
export const kitRoute: SectionRoute = {
  id: 'kit', labelKey: 'shell.nav.overview', icon: Shapes, group: 'hidden', alwaysAvailable: true, Page: KitPage,
};
