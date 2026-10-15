import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { AgentsPage } from '../../src/pages/AgentsPage';
import { CoreConnectionContext } from '../../src/coreConnection';
import { I18nProvider } from '../../src/i18n';
import '../../src/styles/index.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'en');
localStorage.setItem('cpa-gui.agent-selected-client.v1', 'opencode');
document.documentElement.dataset.theme = 'light';
const fixture = window as any;
fixture.calls = [];
fixture.offline = false;
fixture.failApply = false;
fixture.failRestore = false;
fixture.defer = '';
fixture.identityChanged = false;
let selected: string | null = null;
let selectionRevision = 0;
let coreRevision = 7;
let connection = { mode: new URLSearchParams(location.search).has('local-core') ? 'local' as const : 'remote' as const, remoteManagementOrigin: 'https://core.test', remoteManagementKey: 'management-only', clientApiOrigin: new URLSearchParams(location.search).get('origin') || 'http://core.test:8317', clientApiKey: 'client-only' };
const machines = [
  { id: 'alpha', label: 'Alpha Linux', destination: 'tester@alpha', identity: 'identity-alpha' },
  { id: 'beta', label: 'Beta Linux', destination: 'tester@beta', identity: 'identity-beta' },
];
const configs: Record<string, { model: string | null; revision: number }> = {};
const backups: Record<string, any[]> = {};
const probe = (destination: string) => ({ identity: fixture.identityChanged ? 'changed-identity' : `identity-${destination.split('@').at(-1)}`, os: 'linux', arch: 'x86_64', home: '/home/tester', clients: [
  { id: 'claude-code', name: 'Claude Code', paths: ['/home/tester/.claude/settings.json'], supported: true, reason: null },
  { id: 'opencode', name: 'OpenCode', paths: ['/home/tester/.config/opencode/opencode.json'], supported: true, reason: null },
  { id: 'codex', name: 'Codex', paths: [], supported: false, reason: 'Unsupported by remote prototype' },
], limits: ['Linux only; no remote client launch.'] });
mockIPC(async (cmd, args: any) => {
  fixture.calls.push({ cmd, args });
  if (cmd === 'list_remote_machines') return machines;
  if (cmd === 'select_agent_machine') {
    if (fixture.defer === 'select') { fixture.defer = ''; await new Promise(resolve => { fixture.finish = resolve; }); }
    selected = args.machineId; return { machineId: selected, revision: ++selectionRevision, coreRevision };
  }
  if (cmd === 'probe_remote_machine') {
    if (fixture.defer === 'probe') { fixture.defer = ''; await new Promise(resolve => { fixture.finish = resolve; }); }
    if (fixture.offline) throw new Error('SSH unavailable or host key verification failed');
    return probe(args.destination);
  }
  if (cmd === 'save_remote_machine') {
    if (args.identity !== probe(args.destination).identity) throw new Error('Identity changed');
    const item = { id: 'new-machine', ...args }; machines.push(item); return item;
  }
  if (cmd === 'remove_remote_machine') { machines.splice(machines.findIndex(item => item.id === args.machineId), 1); return null; }
  if (cmd === 'get_core_connection') return { ...connection };
  if (cmd === 'remote_machine_request') {
    const op = args.operation;
    if (fixture.defer === op.kind) { fixture.defer = ''; await new Promise(resolve => { fixture.finish = resolve; }); }
    if (fixture.offline) throw new Error('SSH request timed out; outcome unknown');
    if (args.machineId !== selected || args.selectionRevision !== selectionRevision || args.coreRevision !== coreRevision) throw new Error('Stale machine/core selection');
    const id = `${args.machineId}:${op.client}`;
    const config = configs[id] ??= { model: null, revision: 1 };
    const versions = backups[id] ??= [];
    if (op.kind === 'inspect') return { revision: String(config.revision), paths: probe('').clients.find(item => item.id === op.client)?.paths || [], configured: !!config.model, currentModel: config.model, configExists: true, configValid: !fixture.invalidConfig };
    if (op.kind === 'apply') {
      if (op.origin !== connection.clientApiOrigin || op.apiKey !== connection.clientApiKey || op.revision !== String(config.revision)) throw new Error('Wrong core target or stale revision');
      const backup = { id: String(versions.length + 1), createdAt: '2026-10-15T12:00:00Z', location: `/home/tester/.easycli/backups/${versions.length + 1}.json`, restorable: true, error: null, model: config.model };
      versions.push(backup); config.model = op.model; config.revision++;
      if (fixture.failApply) throw new Error('Disconnected after apply; outcome unknown');
      return { outcome: 'updated', changedFiles: ['/home/tester/.claude/settings.json'], conflictFiles: fixture.conflictApply ? ['/home/tester/.claude/settings.json'] : [] };
    }
    if (op.kind === 'backup') {
      if (op.revision !== String(config.revision)) throw new Error('Stale backup revision');
      const backup = { id: String(versions.length + 1), createdAt: '2026-10-15T12:00:00Z', location: `/home/tester/.easycli/backups/${versions.length + 1}.json`, restorable: true, error: null, model: config.model };
      versions.push(backup); return backup;
    }
    if (op.kind === 'clear') {
      if (op.revision !== String(config.revision)) throw new Error('Stale clear revision');
      config.model = null; config.revision++; return { outcome: 'updated' };
    }
    if (op.kind === 'backups') return { versions };
    if (op.kind === 'preview') return { revision: String(config.revision), files: [{ path: '/home/tester/.claude/settings.json' }], differences: [{ file: '/home/tester/.claude/settings.json', field: 'managed model', before: config.model || 'not configured', after: 'backup model' }] };
    if (op.kind === 'restore') {
      if (op.revision !== String(config.revision)) throw new Error('Stale backup preview');
      config.model = versions.find(item => item.id === op.backupId).model; config.revision++; fixture.invalidConfig = false;
      if (fixture.failRestore) throw new Error('Disconnected after restore; outcome unknown');
      return { outcome: 'updated' };
    }
    throw new Error('Unknown remote fixture operation');
  }
  if (cmd === 'plugin:event|listen') return 1;
  if (cmd === 'plugin:event|unlisten' || cmd === 'set_app_locale') return null;
  if (cmd === 'get_agent_models') return [{ name: 'local-model' }];
  if (cmd === 'get_agent_config_statuses' || cmd === 'refresh_agent_config_statuses') return [{ id: 'opencode', name: 'OpenCode', supportedPlatform: true, installed: false, configExists: false, configValid: true, configured: false, launchTargets: [], warnings: [], currentModel: null, connectionState: 'not-configured', modificationState: 'unconfigured' }];
  throw new Error(`Unhandled fixture command: ${cmd}`);
});
function Fixture() {
  const [target, setTarget] = useState(connection);
  fixture.changeCore = () => { coreRevision++; connection = { ...connection, clientApiOrigin: 'https://changed-core.test', clientApiKey: 'new-client-key' }; setTarget(connection); };
  return <I18nProvider><CoreConnectionContext.Provider value={{ connection: target, reload() {} }}><AgentsPage /></CoreConnectionContext.Provider></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
