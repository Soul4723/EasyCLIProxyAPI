// Dev-only harness (#/providers?preview=signin). Removed when the Providers page is assembled.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCoreRuntime } from '../../../coreRuntime';
import { notifyPluginResourcesChanged } from '../../../services/pluginResources';
import { navigate } from '../../../shell/router';
import { Badge, Button, Card, ProviderLogo, SegmentedControl } from '../../../ui';
import { useOAuthSignIn } from './useOAuthSignIn';
import { VertexImportDialog } from './VertexImportDialog';
import type { SigninMockControl } from './mock';

const L = {
  title: 'Sign-in harness',
  providers: 'Providers',
  script: 'Scripted core',
  link: 'Link',
  fast: 'Instant',
  slow: 'Slow (4s)',
  flow: 'Flow',
  browserFlow: 'Browser',
  deviceFlow: 'Device code',
  status: 'Poll result',
  waiting: 'Waiting',
  ok: 'Success',
  failed: 'Failed',
  callback: 'Callback',
  accepted: 'Accepted',
  rejected: 'Rejected',
  open: 'Browser open',
  works: 'Works',
  fails: 'Fails',
  plugins: 'Plugin providers',
  off: 'Off',
  on: 'On',
  core: 'Core',
  local: 'Local',
  remote: 'Remote',
  standalone: 'Standalone Vertex dialog',
  openVertex: 'Open',
  last: 'onSuccess',
  none: '–',
};

const pluginEntry = (id: string, name: string) => ({
  id, path: `/plugins/${id}`, configured: true, registered: true, enabled: true, effective_enabled: true,
  supports_oauth: true, oauth_provider: id, supports_quota: false, logo: '', menus: [], config_fields: [],
  metadata: { name, version: '1.0.0', author: 'Preview', logo: '', config_fields: [] },
});

export default function SigninPreview() {
  const { refreshStatus } = useCoreRuntime();
  const [last, setLast] = useState('');
  const controller = useOAuthSignIn({ onSuccess: setLast });
  const [slow, setSlow] = useState(false);
  const [device, setDevice] = useState(false);
  const [status, setStatus] = useState<'wait' | 'ok' | 'error'>('wait');
  const [callbackFails, setCallbackFails] = useState(false);
  const [openFails, setOpenFails] = useState(false);
  const [plugins, setPlugins] = useState(false);
  const [vertex, setVertex] = useState(false);

  useEffect(() => {
    const script: SigninMockControl = {
      startDelayMs: slow ? 4000 : 0,
      userCode: device ? 'WDJB-MJHT' : undefined,
      status,
      statusError: 'access_denied: the user rejected the request',
      callbackError: callbackFails ? 'state does not match the pending session' : undefined,
      openFailed: openFails,
      expiresIn: 900,
    };
    window.__ecSigninMock = script;
    return () => { delete window.__ecSigninMock; };
  }, [slow, device, status, callbackFails, openFails]);

  useEffect(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = (cmd: unknown, args: unknown, options: unknown) => {
      const request = (args as { request?: { method?: string; path?: string } } | undefined)?.request;
      if (plugins && cmd === 'management_request' && request?.path === '/plugins' && request.method === 'GET') {
        return Promise.resolve({
          plugins_enabled: true, plugins_dir: '/plugins',
          plugins: [pluginEntry('zcode', 'ZCode'), pluginEntry('codebuddy', 'CodeBuddy')],
        });
      }
      return original(cmd, args, options);
    };
    notifyPluginResourcesChanged();
    return () => { internals.invoke = original; notifyPluginResourcesChanged(); };
  }, [plugins]);

  const setRemoteMode = async (next: boolean) => {
    if (next) {
      await invoke('stop_core_process').catch(() => undefined);
      await invoke('save_core_connection', { connection: {
        mode: 'remote', managementOrigin: 'https://core.example.test', managementKey: 'fixture-management-key',
        clientOrigin: 'https://core.example.test', clientKey: 'fixture-client-key',
      } });
    } else {
      await invoke('save_core_connection', { connection: {
        mode: 'local', managementOrigin: '', managementKey: '', clientOrigin: '', clientKey: '',
      } });
      await invoke('start_core_process').catch(() => undefined);
    }
    await refreshStatus();
    // Stopping the local core locks pages and redirects to Overview; come back to the harness.
    navigate('/providers?preview=signin', { replace: true });
  };

  const toggle = (value: boolean, set: (next: boolean) => void, on: string, off: string, label: string) => (
    <div className="ec-signin-harness__row">
      <span className="ec-muted">{label}</span>
      <SegmentedControl
        size="sm"
        ariaLabel={label}
        value={value ? 'on' : 'off'}
        onChange={(next) => set(next === 'on')}
        options={[{ value: 'off', label: off }, { value: 'on', label: on }]}
      />
    </div>
  );

  return (
    <div className="ec-page-body" style={{ maxWidth: 960 }}>
      <Card>
        <h2 style={{ margin: 0, fontSize: 'var(--ec-fs-lg)' }}>{L.title}</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ec-sp-2)', margin: 'var(--ec-sp-3) 0' }} data-testid="providers">
          {controller.providers.map((provider) => (
            <Button
              key={provider.id}
              data-provider={provider.id}
              data-flow={controller.flowState(provider.id)}
              icon={<ProviderLogo provider={provider.brand} size={18} />}
              onClick={() => controller.start(provider.id)}
            >
              {provider.name}
              <Badge>{controller.flowState(provider.id)}</Badge>
            </Button>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 'var(--ec-sp-2)' }}>
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.link}</span>
            <SegmentedControl size="sm" ariaLabel={L.link} value={slow ? 'slow' : 'fast'} onChange={(next) => setSlow(next === 'slow')}
              options={[{ value: 'fast', label: L.fast }, { value: 'slow', label: L.slow }]} />
          </div>
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.flow}</span>
            <SegmentedControl size="sm" ariaLabel={L.flow} value={device ? 'device' : 'browser'} onChange={(next) => setDevice(next === 'device')}
              options={[{ value: 'browser', label: L.browserFlow }, { value: 'device', label: L.deviceFlow }]} />
          </div>
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.status}</span>
            <SegmentedControl size="sm" ariaLabel={L.status} value={status} onChange={setStatus}
              options={[{ value: 'wait', label: L.waiting }, { value: 'ok', label: L.ok }, { value: 'error', label: L.failed }]} />
          </div>
          {toggle(callbackFails, setCallbackFails, L.rejected, L.accepted, L.callback)}
          {toggle(openFails, setOpenFails, L.fails, L.works, L.open)}
          {toggle(plugins, setPlugins, L.on, L.off, L.plugins)}
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.core}</span>
            <SegmentedControl size="sm" ariaLabel={L.core} value={controller.remote ? 'remote' : 'local'} onChange={(next) => void setRemoteMode(next === 'remote')}
              options={[{ value: 'local', label: L.local }, { value: 'remote', label: L.remote }]} />
          </div>
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.standalone}</span>
            <Button size="sm" onClick={() => setVertex(true)}>{L.openVertex}</Button>
          </div>
          <div className="ec-signin-harness__row">
            <span className="ec-muted">{L.last}</span>
            <span className="ec-mono" data-testid="last-success">{last || L.none}</span>
          </div>
        </div>
      </Card>
      {controller.dialogs}
      <VertexImportDialog open={vertex} onClose={() => setVertex(false)} />
    </div>
  );
}
