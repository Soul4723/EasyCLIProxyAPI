import type { SectionMockFactory } from '../../../mocks/sectionMockTypes';

/** Browser-mock handlers for the signin part of Providers; chained from ../mock.ts. */
export const signinMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
