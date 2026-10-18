import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import '../../src/styles/index.css';
import { SignInHarness, coreStatus } from './signinHarness';

const params = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', params.get('locale') ?? 'en');
localStorage.setItem('easy-cli-proxy-api.oauth-browser.v3', 'none');
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
// Keep OAuth polling quick in this fixture while preserving the production timer behavior.
const nativeSetInterval = window.setInterval.bind(window);
(window as any).setInterval = (handler: TimerHandler, timeout?: number, ...args: any[]) =>
  nativeSetInterval(handler, timeout === 3000 ? 25 : timeout, ...args);
const file = { name: 'devin-test.json', provider: 'devin', auth_index: 'devin-index', status: 'active' };
const fixture = {
  calls: [] as Array<{ cmd: string; args: any }>,
  attempts: 0,
  status: 'wait',
  cancelError: false,
  completeOnSubmit: true,
  holdStatus: false,
  priorityPatches: [] as Array<{ name: string; priority: number }>,
  copied: [] as string[],
  releaseStatus: null as null | (() => void),
  files: [] as typeof file[],
};
Object.assign(window, { devinFixture: fixture });
mockIPC(async (cmd, args: any) => {
  fixture.calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'get_core_status') return coreStatus(params.has('remote'));
  if (cmd === 'list_oauth_browsers') return [{ id: 'default', label: 'System Default' }];
  if (cmd === 'get_plugin_support') return false;
  if (cmd === 'start_oauth_login') {
    fixture.attempts++;
    fixture.status = 'wait';
    return { url: 'https://auth.devin.ai/authorize?state=attempt-' + fixture.attempts, state: 'attempt-' + fixture.attempts, opened: true };
  }
  if (cmd === 'get_oauth_status') {
    if (fixture.holdStatus) {
      fixture.holdStatus = false;
      return new Promise((resolve) => { fixture.releaseStatus = () => resolve({ status: 'ok' }); });
    }
    if (fixture.status === 'ok') fixture.files = [file];
    return { status: fixture.status };
  }
  if (cmd === 'submit_oauth_callback') { if (fixture.completeOnSubmit) fixture.status = 'ok'; return null; }
  if (cmd === 'open_oauth_url') return null;
  if (cmd === 'management_request') {
    const request = args.request;
    if (request.path === '/credentials') return { files: fixture.files };
    if (request.path === '/config') return {};
    if (request.path === '/credentials/fields') {
      fixture.priorityPatches.push({ name: String(request.body?.name), priority: Number(request.body?.priority) });
      return {};
    }
    if (request.path === '/oauth/session') {
      if (fixture.cancelError) throw new Error('Cancellation failed');
      return { status: 'ok', cancelled: true };
    }
  }
  throw new Error('Unexpected command: ' + cmd + ' ' + JSON.stringify(args));
}, { shouldMockEvents: true });
createRoot(document.getElementById('root')!).render(<SignInHarness />);
