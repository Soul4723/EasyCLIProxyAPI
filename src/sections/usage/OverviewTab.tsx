import { useI18n } from '../../i18n';
import { EmptyState } from '../../ui';

/** Usage → overview tab. TODO(worker): replace this stub. */
export function OverviewTab() {
  const { t } = useI18n();
  return <EmptyState title={t('sec.usage.title')} />;
}
