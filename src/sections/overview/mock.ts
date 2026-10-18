import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the overview section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const overviewMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
