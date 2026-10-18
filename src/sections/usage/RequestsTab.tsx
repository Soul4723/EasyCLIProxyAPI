import { useI18n } from '../../i18n';
import { EmptyState } from '../../ui';

/** Usage → requests tab. TODO(worker): replace this stub. */
export function RequestsTab() {
  const { t } = useI18n();
  return <EmptyState title={t('sec.usage.title')} />;
}
