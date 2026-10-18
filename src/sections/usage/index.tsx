import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { UsageRecordsPage } from '../../pages/UsageRecordsPage';
import { usageSubs } from './subs';
import './usage.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function UsageSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="usage" titleKey="shell.nav.usage" subs={usageSubs} sub={sub}>
      {<UsageRecordsPage />}
    </LegacyHost>
  );
}
