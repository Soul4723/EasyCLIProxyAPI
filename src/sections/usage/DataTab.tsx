import { useI18n } from '../../i18n';
import { EmptyState } from '../../ui';

/** Usage → data tab. TODO(worker): replace this stub. */
export function DataTab() {
  const { t } = useI18n();
  return <EmptyState title={t('sec.usage.title')} />;
}
