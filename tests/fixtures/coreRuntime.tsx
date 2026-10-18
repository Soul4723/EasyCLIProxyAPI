import type { ReactNode } from 'react';
import { CoreRuntimeProvider, type CoreStatus } from '../../src/coreRuntime';

// Page fixtures render real components that read the core connection through
// useCoreRuntime(), so they mount the real provider and answer its IPC here.
// `?remote` shows the page as connected to a remote core.
export function fixtureCoreStatus(params: URLSearchParams): CoreStatus {
  const remote = params.has('remote');
  return {
    connectionMode: remote ? 'remote' : 'local',
    remoteOrigin: remote ? 'https://core.example.test' : null,
    installed: true, running: !remote, ready: true, starting: false, managed: !remote,
    processId: remote ? null : 4242, currentVersion: '7.3.15',
    installDir: '/fixture/cpa-core', binaryPath: '/fixture/cpa-core/cli-proxy-api',
    message: remote ? 'Fixture remote core' : 'Fixture core is running',
  };
}

export function MockCoreRuntime({ children }: { children: ReactNode }) {
  return <CoreRuntimeProvider>{children}</CoreRuntimeProvider>;
}
