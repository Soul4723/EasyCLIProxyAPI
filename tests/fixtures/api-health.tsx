import { mockIPC } from '@tauri-apps/api/mocks';
import { mountApiHarness } from './apiHarness';

// Provider health: one Claude config answers, one is "broken"; Codex has no configured models (discovery supplies one)
// and a disabled sibling that "check all" must skip.
localStorage.setItem('easy-cli-proxy-api.locale', new URLSearchParams(location.search).get('locale') ?? 'en');
const fixture = window as typeof window & { healthFixture: { probes: { url: string; model: string }[]; discoveries: number } };
fixture.healthFixture = { probes: [], discoveries: 0 };
const sections: Record<string, Record<string, unknown>[]> = {
  claude: [
    { name: 'Claude ok', 'base-url': 'https://claude.example.test', models: [{ name: 'claude-a' }, { name: 'claude-b', alias: 'fast' }], keys: [{ name: 'Claude ok', 'api-key': 'claude-ok-key' }] },
    { name: 'Claude broken', 'base-url': 'https://broken.example.test', models: [{ name: 'claude-c' }], keys: [{ name: 'Claude broken', 'api-key': 'claude-broken-key' }] },
  ],
  codex: [
    { name: 'Codex ok', 'base-url': 'https://codex.example.test/v1', models: [], keys: [{ name: 'Codex ok', 'api-key': 'codex-ok-key' }] },
    { name: 'Codex off', 'base-url': 'https://codex-off.example.test/v1', 'excluded-models': ['*'], models: [{ name: 'codex-off-model' }], keys: [{ name: 'Codex off', 'api-key': 'codex-off-key' }] },
  ],
};
mockIPC((cmd, rawArgs) => {
  if (cmd === 'get_management_target_revision') return 0; // documentTarget fences every target command
  if (cmd === 'set_app_locale') return null;
  // Remarks come from the app store; the fixture uses the config name so rows are identifiable.
  if (cmd === 'resolve_api_access_remarks') return (rawArgs as { queries: { providerName: string }[] }).queries.map((query) => query.providerName);
  if (cmd === 'save_api_access_remark') return null;
  if (cmd === 'provider_health_probe') {
    const { request } = rawArgs as { request: { url: string; model: string } };
    fixture.healthFixture.probes.push({ url: request.url, model: request.model });
    if (request.url.includes('broken')) throw new Error('HTTP 502 upstream connect error');
    return { firstTokenLatencyMs: 120, responseLatencyMs: 340 };
  }
  if (cmd === 'management_request') {
    const { request } = rawArgs as { request: { method: string; path: string } };
    if (request.method === 'POST' && request.path === '/requests/api-call') {
      fixture.healthFixture.discoveries += 1;
      return { status_code: 200, body: { data: [{ id: 'discovered-model' }] } };
    }
    const section = request.path.replace('/config/api-keys/', '');
    if (request.method === 'GET' && request.path.startsWith('/config/api-keys/')) return structuredClone(sections[section] ?? []);
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});
mountApiHarness();
