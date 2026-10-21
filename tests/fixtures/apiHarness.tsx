import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n';
import { Button, FilterChips } from '../../src/ui';
import { AddKeyButton, API_KINDS, ApiKeyList, useApiProviders } from '../../src/sections/providers/api';
import '../../src/styles/index.css';
import '../../src/ui/index.css';

// Test harness for the API-key package: the real controller + list + dialogs on the kit styles, without the shell.
// Query: ?brand=<brand id> (default codex) · ?locale=… · ?theme=dark|light · ?density=comfortable|compact · ?compact=1 (compact rows).
const BRANDS = Array.from(new Set(API_KINDS.map((kind) => kind.brand)));
const labels: Record<string, string> = { codex: 'Codex', openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude', gemini: 'Gemini', vertex: 'Vertex AI', xai: 'xAI', meta: 'Meta' };

function Harness() {
  const query = new URLSearchParams(location.search);
  const controller = useApiProviders();
  const [brand, setBrand] = useState(query.get('brand') ?? 'codex');
  return (
    <main className="ec-page-body" style={{ maxWidth: 1180, margin: '0 auto' }}>
      <FilterChips
        ariaLabel="Brand"
        value={brand}
        onChange={setBrand}
        options={BRANDS.map((id) => ({ value: id, label: labels[id] ?? id, count: controller.countByBrand[id] ?? 0 }))}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <AddKeyButton controller={controller} brand={brand} />
        <Button onClick={() => void controller.reload()}>Refresh</Button>
        <Button onClick={() => controller.checkAllHealth(brand)}>Check all</Button>
      </div>
      <ApiKeyList controller={controller} brand={brand} compact={query.get('compact') === '1'} />
      {controller.dialogs}
    </main>
  );
}

export function mountApiHarness() {
  const query = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = query.get('theme') ?? 'dark';
  document.documentElement.dataset.density = query.get('density') ?? 'comfortable';
  createRoot(document.getElementById('root')!).render(<I18nProvider><Harness /></I18nProvider>);
}
