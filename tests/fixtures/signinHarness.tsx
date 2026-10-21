// Minimal host page for the sign-in controller: one button per provider, the controller's dialogs, and a log of
// onSuccess callbacks. Used by the devin / meta-oauth / plugin-oauth-providers fixtures.
import { CoreRuntimeProvider } from '../../src/coreRuntime';
import { I18nProvider } from '../../src/i18n';
import { useOAuthSignIn } from '../../src/sections/providers/signin';
import '../../src/styles/index.css';
import '../../src/ui/index.css';

declare global {
  interface Window { signinSuccesses: string[] }
}
window.signinSuccesses = [];

export const coreStatus = (remote = false) => ({
  connectionMode: remote ? 'remote' : 'local',
  remoteOrigin: remote ? 'https://core.example.test' : null,
  installed: true, running: true, ready: true, starting: false, managed: !remote, processId: 1,
  currentVersion: '8.0.0', installDir: '', binaryPath: null, message: '',
});

function Harness() {
  const controller = useOAuthSignIn({ onSuccess: (id) => window.signinSuccesses.push(id) });
  return (
    <main style={{ padding: 24 }}>
      <div data-testid="providers" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {controller.providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            data-provider={provider.id}
            data-flow={controller.flowState(provider.id)}
            onClick={() => controller.start(provider.id)}
          >
            {provider.name}
          </button>
        ))}
      </div>
      {controller.pluginError ? <p role="alert" data-testid="plugin-error">plugin sign-in unavailable</p> : null}
      <button type="button" data-testid="reload" onClick={controller.reload}>reload</button>
      <p data-testid="active">{controller.activeProviderId ?? ''}</p>
      {controller.dialogs}
    </main>
  );
}

export function SignInHarness() {
  return <I18nProvider><CoreRuntimeProvider><Harness /></CoreRuntimeProvider></I18nProvider>;
}
