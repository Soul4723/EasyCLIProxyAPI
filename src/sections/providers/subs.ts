import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. Empty = no tabs. */
export const providersSubs: readonly SectionSub[] = [{ id: 'api', labelKey: 'app.nav.api' }, { id: 'oauth', labelKey: 'app.nav.oauth' }];
