import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the quota section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const quotaMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
