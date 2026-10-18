import { useI18n } from '../../i18n';
import { EmptyState } from '../../ui';

/** Usage → routing tab. TODO(worker): replace this stub. */
export function RoutingTab() {
  const { t } = useI18n();
  return <EmptyState title={t('sec.usage.title')} />;
}
