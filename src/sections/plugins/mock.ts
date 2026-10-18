import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the plugins section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const pluginsMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
