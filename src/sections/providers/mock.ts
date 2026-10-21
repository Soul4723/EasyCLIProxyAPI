import type { SectionMockFactory } from '../../mocks/sectionMockTypes';
import { apiMock } from './api/mock';
import { credsMock } from './creds/mock';
import { signinMock } from './signin/mock';

/** Browser-mock handlers owned by the providers section (see src/mocks/sectionMocks.ts): chains the three sub-modules. */
export const providersMock: SectionMockFactory = (host) => {
  const handlers = [apiMock(host), credsMock(host), signinMock(host)];
  return {
    handle(command, payload) {
      for (const handler of handlers) {
        const result = handler.handle(command, payload);
        if (result.handled) return result;
      }
      return { handled: false };
    },
  };
};
