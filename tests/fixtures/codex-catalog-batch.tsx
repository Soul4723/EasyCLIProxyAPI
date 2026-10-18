import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { CodexCatalogDialog } from '../../src/sections/agents/CodexCatalogDialog';
import { I18nProvider } from '../../src/i18n';
import '../../src/styles/index.css';
import '../../src/ui/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') || 'en');
document.documentElement.dataset.theme = params.get('theme') || 'light';
const models = ['alpha/one', 'alpha/two', 'beta/three'].map((slug, index) => {
  const configuration = {
    display_name: slug, description: `Description ${index}`, base_instructions: `Prompt ${index}`,
    context_window: 128000, max_context_window: 256000, effective_context_window_percent: 95,
    auto_compact_token_limit: null, default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'Custom reasoning' }],
    input_modalities: ['text', 'image'], visibility: index === 1 ? 'none' : 'list',
    supports_parallel_tool_calls: true,
    // Extra catalog fields must survive batch updates and the existing save payload.
    service_tiers: ['fast', 'flex'], default_service_tier: 'fast',
  };
  return { slug, hasOfficialTemplate: true, contextSource: 'client', customized: false,
    configuration, defaults: structuredClone(configuration) };
});
let snapshot = { revision: 'fixture-1', models: params.has('empty') ? [] : models };
const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls, fixtureOriginal: structuredClone(snapshot) });
mockIPC((cmd, args: any) => {
  calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'get_codex_model_catalog_editor') return structuredClone(snapshot);
  if (cmd === 'save_codex_model_catalog_editor') {
    if ((window as any).fixtureFailSave) throw new Error('Fixture save failed');
    snapshot = { revision: 'fixture-2', models: snapshot.models.map((model) => ({
      ...model, configuration: args.request.models.find((item: any) => item.slug === model.slug).configuration,
    })) };
    return { snapshot: structuredClone(snapshot), synchronizationError: null };
  }
  throw new Error(`Unexpected fixture command: ${cmd}`);
});
function Fixture() {
  const [open, setOpen] = useState(true);
  return <I18nProvider>{open
    ? <CodexCatalogDialog onClose={() => setOpen(false)} onSaved={() => {}} />
    : <button onClick={() => setOpen(true)}>Reopen catalog</button>}</I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
