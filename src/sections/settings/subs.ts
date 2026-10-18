import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. Empty = no tabs. */
export const settingsSubs: readonly SectionSub[] = [{ id: 'general', labelKey: 'app.nav.config' }, { id: 'updates', labelKey: 'app.nav.versions' }];
