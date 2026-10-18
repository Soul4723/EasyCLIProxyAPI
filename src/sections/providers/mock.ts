import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the providers section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const providersMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
