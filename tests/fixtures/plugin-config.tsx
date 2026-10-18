import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { CoreRuntimeProvider } from '../../src/coreRuntime';
import { PluginsSection } from '../../src/sections/plugins';
import { resetRouterForTests, useRoute } from '../../src/shell/router';
import { pluginsApi, type PluginConfigObject } from '../../src/services/plugins';
import '../../src/styles/index.css';
import '../../src/ui/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
if (!location.hash) location.hash = '/plugins';
resetRouterForTests(location.hash);
const fixture = {
  loads: 0,
  saved: 0,
  patches: [] as PluginConfigObject[],
  options: [] as unknown[],
  holdSave: false,
  releaseSave: null as null | (() => void),
};
Object.assign(window, { pluginConfigFixture: fixture });
const config: PluginConfigObject = {
  enabled: true, priority: 4, token: ' keep spaces ', retries: 2, timeout: 0.5,
  active: false, modes: ['chat'], headers: { old: 'value' }, algorithm: 'fast',
  undeclared: { preserved: true },
};
pluginsApi.getConfig = async () => {
  fixture.loads += 1;
  if (params.has('loadError') && fixture.loads === 1) throw new Error('Fixture load failure');
  return { ...config };
};
pluginsApi.patchConfig = async (_id, patch, options) => {
  fixture.patches.push(patch);
  fixture.options.push(options);
  if (fixture.holdSave) await new Promise<void>(resolve => { fixture.releaseSave = resolve; });
  fixture.saved += 1;
  return { ...config, ...patch };
};
// The section lists one plugin; its Configure button opens the config side panel (config is read/written through the patched pluginsApi above).
const configFields = params.has('raw') ? [] : [
  ['token', 'string'], ['retries', 'integer'], ['timeout', 'number'], ['active', 'boolean'],
  ['modes', 'array'], ['headers', 'object'], ['algorithm', 'enum'], ['inherited', 'boolean'],
].map(([name, type]) => ({ name, type, description: `${name} configuration`, enum_values: type === 'enum' ? ['fast', 'accurate'] : [] }));
mockIPC(async (command, args) => {
  if (command === 'get_plugin_support') return true;
  if (command !== 'management_request') return null;
  const request = (args as { request: { method: string; path: string } }).request;
  if (request.path === '/plugins' && request.method === 'GET') {
    return {
      plugins_enabled: true, plugins_dir: 'plugins',
      plugins: [{
        id: 'test-plugin', path: '/plugins/test', configured: true, registered: true, enabled: true, effective_enabled: true,
        supports_oauth: false, metadata: null, menus: [], config_fields: configFields,
      }],
    };
  }
  if (request.path === '/plugins/store' && request.method === 'GET') return { plugins_enabled: true, plugins_dir: 'plugins', plugins: [], sources: [], source_errors: [] };
  throw new Error(`Unhandled fixture request: ${request.method} ${request.path}`);
});

function Host() {
  const route = useRoute();
  return <PluginsSection sub={route.sub} params={route.params} />;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><CoreRuntimeProvider><Host /></CoreRuntimeProvider></I18nProvider>);
