import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the usage section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const usageMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
