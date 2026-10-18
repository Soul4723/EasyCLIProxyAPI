import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { QuotaPage } from '../../pages/QuotaPage';
import { quotaSubs } from './subs';
import './quota.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function QuotaSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="quota" titleKey="shell.nav.quota" subs={quotaSubs} sub={sub}>
      {<QuotaPage />}
    </LegacyHost>
  );
}
