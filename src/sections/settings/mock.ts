import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the settings section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const settingsMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
