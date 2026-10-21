import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { Tabs } from '../ui/Tabs';
import { navigate, routePath } from './router';

/**
 * Sub-page tabs synced with the hash: `#/<page>/<sub>`. Pass the page id, the sub list and the active sub id.
 * Keeps the query string out (sub-pages start clean).
 */
export function RouteTabs({ page, subs, active, ariaLabel }: {
  page: string;
  subs: ReadonlyArray<{ id: string; labelKey: MessageKey; count?: number }>;
  active: string;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  return (
    <Tabs
      ariaLabel={ariaLabel}
      idBase={`${page}-subtabs`}
      active={active}
      tabs={subs.map((sub) => ({ id: sub.id, label: t(sub.labelKey), count: sub.count }))}
      onChange={(id) => navigate(routePath(page, id === subs[0].id ? null : id))}
    />
  );
}
