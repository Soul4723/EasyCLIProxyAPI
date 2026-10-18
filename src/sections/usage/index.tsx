import { PageHeader } from '../../shell/PageHeader';
import { RouteTabs } from '../../shell/RouteTabs';
import type { SectionPageProps } from '../../shell/types';
import { useI18n } from '../../i18n';
import { Button, ErrorState, tabPanelProps } from '../../ui';
import { CollectorChip, PeriodControl } from './HeaderActions';
import { DataTab } from './DataTab';
import { OverviewTab } from './OverviewTab';
import { PricesTab } from './PricesTab';
import { RequestsTab } from './RequestsTab';
import { RoutingTab } from './RoutingTab';
import { usageSubs } from './subs';
import { UsageProvider, useUsage } from './UsageContext';
import './usage.css';

// 'live' was the pre-merge name of the routing tab.
const resolveSub = (sub: string | null) => {
  const id = sub === 'live' ? 'routing' : sub;
  return usageSubs.find((s) => s.id === id)?.id ?? usageSubs[0].id;
};

/** Usage page: stats (Overview), request log (Requests), Live routing, Prices, Data. Deep links: #/usage/requests?account=<auth_index>&provider=<p>. */
export function UsageSection({ sub, params }: SectionPageProps) {
  const { t } = useI18n();
  const active = resolveSub(sub);
  const showPeriod = active === 'overview' || active === 'requests' || active === 'prices';
  return (
    <UsageProvider params={params} needsOptions={active === 'overview' || active === 'requests'}>
      <div className="ec-sec-usage">
        <PageHeader
          title={t('sec.usage.title')}
          tabs={<RouteTabs page="usage" subs={usageSubs} active={active} ariaLabel={t('sec.usage.tabsLabel')} />}
          actions={<><CollectorChip /><RefreshButton />{showPeriod ? <PeriodControl /> : null}</>}
        />
        <div className="ec-page-body usage-body" {...tabPanelProps('usage-subtabs', active)}>
          <UsageError />
          {active === 'overview' ? <OverviewTab /> : null}
          {active === 'requests' ? <RequestsTab /> : null}
          {active === 'routing' ? <RoutingTab /> : null}
          {active === 'prices' ? <PricesTab /> : null}
          {active === 'data' ? <DataTab /> : null}
        </div>
      </div>
    </UsageProvider>
  );
}

function RefreshButton() {
  const { refresh } = useUsage();
  const { t } = useI18n();
  return <Button size="sm" variant="outline" onClick={refresh}>{t('common.refresh')}</Button>;
}

function UsageError() {
  const { error, refresh } = useUsage();
  const { t } = useI18n();
  return error ? <ErrorState title={t('sec.usage.error.load')} message={error} onRetry={refresh} retryLabel={t('sec.usage.retry')} /> : null;
}
