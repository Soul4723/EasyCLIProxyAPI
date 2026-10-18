import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import { DataCollector } from './DataCollector';
import { DataNoticeLine, DataStorage, useDataNotice } from './DataStorage';
import './Data.css';

/** Usage → data tab: storage size and limit, maintenance (shrink, repair), and collector state. */
export function DataTab() {
  const { t } = useI18n();
  const { notice, showNotice, dismissNotice } = useDataNotice();
  return (
    <div className="data-tab">
      <div className="data-toolbar">
        <a className="data-export" href={routeHref('usage', 'requests')}>{t('sec.usage.data.export')}</a>
      </div>
      {notice ? <DataNoticeLine notice={notice} onDismiss={dismissNotice} /> : null}
      <div className="data-grid">
        <DataStorage onNotice={showNotice} />
        <DataCollector onNotice={showNotice} />
      </div>
    </div>
  );
}
