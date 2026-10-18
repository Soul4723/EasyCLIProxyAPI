import type { SectionMockFactory } from '../../../mocks/sectionMockTypes';

/** Browser-mock handlers for the api part of Providers; chained from ../mock.ts. */
export const apiMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
