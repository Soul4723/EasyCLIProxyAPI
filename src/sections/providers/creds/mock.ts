import type { SectionMockFactory } from '../../../mocks/sectionMockTypes';

/** Browser-mock handlers for the creds part of Providers; chained from ../mock.ts. */
export const credsMock: SectionMockFactory = () => ({
  handle: () => ({ handled: false }),
});
