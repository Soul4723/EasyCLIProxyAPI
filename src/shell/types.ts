import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n/resources';

/** Props every section page receives from the shell. `sub` is the second hash segment (null = default sub-page). */
export type SectionPageProps = {
  sub: string | null;
  params: URLSearchParams;
};

export type SectionSub = { id: string; labelKey: MessageKey };

/**
 * One entry per sidebar page. A section owns its own `route.ts(x)`; the shell only lists them in
 * src/shell/routes.ts. `subs[0]` is the default sub-page; unknown subs fall back to it.
 */
export type SectionRoute = {
  /** Hash segment: `#/<id>` */
  id: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  /** Sidebar block: main (Overview…Usage) or secondary (below the divider). Hidden routes are not in the nav. */
  group: 'main' | 'secondary' | 'hidden';
  subs?: readonly SectionSub[];
  /** Usable while the core is not ready (see src/navigation.ts). */
  alwaysAvailable?: boolean;
  /** Load a lazy page ahead of navigation when its nav item is hovered or focused. */
  preload?: () => void;
  Page: ComponentType<SectionPageProps>;
};
