import { initializeTargetRevision } from '../../src/services/targetInvoke';
initializeTargetRevision(0);
import type { ReactNode } from 'react';
import { CoreConnectionContext } from '../../src/coreConnection';

export function LocalConnectionFixture({ children }: { children: ReactNode }) {
  return <CoreConnectionContext.Provider value={{
    connection: { mode: 'local', remoteManagementOrigin: '', remoteManagementKey: '', clientApiOrigin: '', clientApiKey: '' },
    reload: async () => {},
  }}>{children}</CoreConnectionContext.Provider>;
}
