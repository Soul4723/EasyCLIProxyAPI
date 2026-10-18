import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { KernelPage } from '../../pages/Kernel';
import { Button } from '../../ui/Button';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import { overviewSubs } from './subs';
import './overview.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function OverviewSection({ sub, params: _params }: SectionPageProps) {
  const { t } = useI18n();
  return (
    <LegacyHost page="overview" titleKey="shell.nav.overview" subs={overviewSubs} sub={sub} actions={<a href={routeHref('easy')}><Button size="sm" variant="outline" tabIndex={-1}>{t('shell.easyMode')}</Button></a>}>
      {<KernelPage view="home" />}
    </LegacyHost>
  );
}
