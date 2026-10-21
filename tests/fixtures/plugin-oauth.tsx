import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { CoreRuntimeProvider } from '../../src/coreRuntime';
import { PluginsSection } from '../../src/sections/plugins';
import { resetRouterForTests, useRoute } from '../../src/shell/router';
import '../../src/styles/index.css';
import '../../src/ui/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
if (!location.hash) location.hash = '/plugins';
resetRouterForTests(location.hash);
const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => nativeSetTimeout(handler, timeout === 3000 ? 25 : timeout, ...args)) as typeof window.setTimeout;
const fixture = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  starts: 0, polls: 0, lists: 0,
  /** Sign-in completions: the section re-reads the plugin list once after each one (the first read is the initial load). */
  get completed() { return Math.max(0, this.lists - 1); },
  status: 'wait',
  cancelled: [] as string[],
  copied: [] as string[],
  releaseStart: null as (() => void) | null,
  releaseStatus: null as (() => void) | null,
  unmount: () => {},
};
Object.assign(window, { pluginOAuthFixture: fixture });
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { fixture.copied.push(value); } } });
mockIPC(async (cmd, unknownArgs) => {
  if (cmd === 'get_management_target_revision') return 0; // documentTarget fences every target command
  const args = (unknownArgs ?? {}) as Record<string, unknown>;
  fixture.calls.push({ cmd, args });
  if (cmd === 'start_oauth_login') {
    const attempt = ++fixture.starts;
    if (params.has('startError') && attempt === 1) throw new Error('Fixture start error');
    const result = {
      url: params.has('invalidUrl') ? 'javascript:alert(1)' : `https://login.example.test/authorize?state=plugin-${attempt}`,
      state: params.has('missingState') ? null : `plugin-${attempt}`,
      userCode: params.has('device') ? 'ABCD-EFGH' : null,
      flow: params.has('device') ? 'device' : 'authorization_code',
      expiresIn: params.has('expiry') ? 1 : 900,
      opened: true, openError: null,
    };
    if (params.has('holdStart')) await new Promise<void>(resolve => { fixture.releaseStart = resolve; });
    return result;
  }
  if (cmd === 'get_oauth_status') {
    fixture.polls += 1;
    if (params.has('holdStatus')) await new Promise<void>(resolve => { fixture.releaseStatus = resolve; });
    if (params.has('pollError')) throw new Error('Fixture poll error');
    return { status: fixture.status, error: fixture.status === 'error' ? 'Fixture authorization denied' : null };
  }
  if (cmd === 'get_plugin_support') return true;
  if (cmd === 'management_request') {
    const request = args.request as { method: string; path: string; query: { state: string } };
    if (request.method === 'GET' && request.path === '/plugins') {
      fixture.lists += 1;
      return {
        plugins_enabled: true, plugins_dir: 'plugins',
        plugins: [{
          id: 'test-plugin', path: '/plugins/test', configured: true, registered: true, enabled: true, effective_enabled: !params.has('disabled'),
          supports_oauth: true, oauth_provider: 'grok', metadata: null, menus: [], config_fields: [],
        }],
      };
    }
    if (request.method === 'GET' && request.path === '/plugins/store') return { plugins_enabled: true, plugins_dir: 'plugins', plugins: [], sources: [], source_errors: [] };
    if (request.method === 'DELETE' && request.path === '/oauth/session') fixture.cancelled.push(request.query.state);
    return { status: 'ok', cancelled: true };
  }
  if (cmd === 'open_oauth_url' && params.has('openError')) throw new Error('Fixture browser error');
  return null;
});
// The installed row's Sign in button opens the OAuth dialog; the plugin comes from the faked /plugins list above.
function Host() {
  const route = useRoute();
  return <PluginsSection sub={route.sub} params={route.params} />;
}
const root = createRoot(document.getElementById('root')!);
fixture.unmount = () => root.unmount();
root.render(<I18nProvider><CoreRuntimeProvider><Host /></CoreRuntimeProvider></I18nProvider>);
