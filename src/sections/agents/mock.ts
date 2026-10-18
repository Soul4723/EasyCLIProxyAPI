import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/** Browser-mock handlers owned by the agents section (see src/mocks/sectionMocks.ts). Empty until the section needs new commands. */
export const agentsMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
