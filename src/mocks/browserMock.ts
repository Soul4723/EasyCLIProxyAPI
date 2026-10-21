import { emit } from '@tauri-apps/api/event';
import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import {
  BROWSER_MOCK_CONNECTION_STORAGE_KEY,
  createBrowserMockRuntime,
  resolveBrowserMockOptions,
  type BrowserMockScenario,
  type MockRecoveryPhase,
} from './browserMockRuntime';
import { assertFencedArgs } from './fencedCommands';
import { clampPluginPages, type PluginWebviewMockState } from './pluginMock';
import './browserMock.css';

const STORAGE_KEY = 'easy-cli-proxy-api.browser-mock-scenario';

export type InstalledBrowserMock = {
  scenario: BrowserMockScenario;
  delayMs: number;
};

function readStoredScenario() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeScenario(scenario: BrowserMockScenario) {
  try {
    window.localStorage.setItem(STORAGE_KEY, scenario);
  } catch {
  }
}

function installToolbar(scenario: BrowserMockScenario, delayMs: number) {
  document.getElementById('browser-mock-toolbar')?.remove();

  const toolbar = document.createElement('aside');
  toolbar.id = 'browser-mock-toolbar';
  toolbar.setAttribute('aria-label', 'Browser Mock controls');
  toolbar.title = 'Shown only in regular browser development mode; Mock is disabled in Tauri and production builds.';

  const badge = document.createElement('strong');
  badge.textContent = 'MOCK';

  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Browser Mock scenario');
  const scenarios: Array<[BrowserMockScenario, string]> = [
    ['running', 'Core running'],
    ['stopped', 'Core stopped'],
    ['empty', 'Core not installed'],
    ['error', 'Request error'],
  ];
  scenarios.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === scenario;
    select.append(option);
  });
  select.addEventListener('change', () => {
    const next = select.value as BrowserMockScenario;
    window.sessionStorage.removeItem(BROWSER_MOCK_CONNECTION_STORAGE_KEY);
    storeScenario(next);
    const url = new URL(window.location.href);
    url.searchParams.set('mock', next);
    window.location.assign(url);
  });

  const hint = document.createElement('span');
  hint.textContent = delayMs > 0 ? `${delayMs} ms` : 'Browser debugging';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset mock data';
  reset.addEventListener('click', () => {
    window.sessionStorage.removeItem(BROWSER_MOCK_CONNECTION_STORAGE_KEY);
    window.location.reload();
  });

  toolbar.append(badge, select, hint, reset);
  document.body.append(toolbar);
  document.body.dataset.browserMock = scenario;
}

const clampRecovery = (value: string | null): MockRecoveryPhase | undefined =>
  value === 'waiting' || value === 'restarting' || value === 'failed' ? value : undefined;

function installPluginWebviewPlaceholder() {
  document.querySelector('[data-mock-plugin-webview]')?.remove();

  const placeholder = document.createElement('div');
  placeholder.dataset.mockPluginWebview = '';
  placeholder.hidden = true;
  const title = document.createElement('strong');
  title.textContent = 'Native plugin webview';
  const note = document.createElement('p');
  note.textContent = 'The native plugin webview is not available in browser preview. In the desktop app it covers this area.';
  const controls = document.createElement('p');
  controls.textContent = 'Back, reload and open-in-browser controls are injected into the page by the desktop app and can be dragged.';
  const url = document.createElement('code');
  placeholder.append(title, note, controls, url);
  document.body.append(placeholder);

  return (state: PluginWebviewMockState) => {
    placeholder.hidden = !state.visible;
    placeholder.style.left = `${state.bounds.x}px`;
    placeholder.style.top = `${state.bounds.y}px`;
    placeholder.style.width = `${state.bounds.width}px`;
    placeholder.style.height = `${state.bounds.height}px`;
    placeholder.dataset.mockUrl = state.url;
    placeholder.dataset.mockReloads = String(state.reloads);
    placeholder.dataset.mockLabels = JSON.stringify(state.labels);
    url.textContent = state.url;
  };
}

export function installBrowserMock(): InstalledBrowserMock | null {
  const options = resolveBrowserMockOptions(window.location.search, readStoredScenario());
  if (options.mode === 'off') {
    window.sessionStorage.removeItem(BROWSER_MOCK_CONNECTION_STORAGE_KEY);
    console.info('[Browser Mock] Disabled via ?mock=off.');
    return null;
  }

  storeScenario(options.mode);
  mockWindows('main');
  mockConvertFileSrc('windows');

  const runtime = createBrowserMockRuntime(
    options.mode,
    (event, payload) => {
      queueMicrotask(() => {
        void emit(event, payload);
      });
    },
    options.delayMs,
    clampPluginPages(new URLSearchParams(window.location.search).get('mockPluginPages')),
    installPluginWebviewPlaceholder(),
    window.sessionStorage,
    clampRecovery(new URLSearchParams(window.location.search).get('mockRecovery')),
  );

  mockIPC(async (command, payload) => {
    assertFencedArgs(command, payload);
    return runtime.invoke(command, payload);
  }, {
    shouldMockEvents: true,
  });
  installToolbar(options.mode, options.delayMs);

  console.info(
    `[Browser Mock] Enabled scenario “${options.mode}”${options.delayMs ? ` with a ${options.delayMs} ms delay` : ''}.`,
    'Use ?mock=running|stopped|empty|error to switch scenarios, or ?mock=off to disable.',
  );
  return { scenario: options.mode, delayMs: options.delayMs };
}
