import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { useCoreConnection } from '../coreConnection';
import { requestAppNavigation } from '../navigation';
import './RemoteMachines.css';

type Machine = { id: string; label: string; destination: string; identity: string };
type Client = { id: string; name: string; paths: string[]; supported: boolean; reason: string | null };
type Probe = { identity: string; os: string; arch: string; home: string; clients: Client[]; limits: string[] };
type Inspection = { revision: string; paths: string[]; configured: boolean; currentModel: string | null; configExists: boolean; configValid: boolean };
type Backup = { id: string; createdAt: string; location: string; restorable: boolean; error: string | null };
type Preview = { revision: string; files: { path: string }[]; differences: { file: string; field: string; before: string; after: string }[] };
type ActionResult = { changedFiles?: string[]; conflictFiles?: string[] };
type Selection = { machineId: string | null; revision: number; coreRevision: number };

function isRemoteNetworkOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return ['http:', 'https:'].includes(url.protocol)
      && host !== 'localhost' && !host.endsWith('.localhost')
      && !/^127\./.test(host) && host !== '0.0.0.0'
      && host !== '[::]' && host !== '[::1]'
      && !/^\[::(?:ffff:)?(?:0:0|7f[\da-f]{2}:[\da-f]{1,4})\]$/.test(host);
  } catch { return false; }
}

export function MachineWorkspace({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { connection } = useCoreConnection();
  const fingerprint = JSON.stringify(connection);
  const lastConnection = useRef(fingerprint);
  const [selectionContext, setSelectionContext] = useState('');
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const registryGeneration = useRef(0);
  const selector = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void loadMachines();
    void choose('');
    return () => { alive.current = false; generation.current++; };
  }, []);
  async function loadMachines() {
    const token = ++registryGeneration.current;
    try { const value = await invoke<Machine[]>('list_remote_machines'); if (alive.current && token === registryGeneration.current) setMachines(value); }
    catch (cause) { if (alive.current && token === registryGeneration.current) setError(String(cause)); }
  }
  async function choose(id: string) {
    const token = ++generation.current;
    setSelected(id); setSelection(null); setError('');
    try {
      const next = await invoke<Selection>('select_agent_machine', { machineId: id && id !== 'add' ? id : null });
      if (alive.current && token === generation.current) { setSelectionContext(fingerprint); setSelection(next); }
    } catch (cause) { if (alive.current && token === generation.current) setError(String(cause)); }
  }
  useEffect(() => {
    if (lastConnection.current === fingerprint) return;
    lastConnection.current = fingerprint;
    void choose(selected);
  }, [fingerprint]);
  const currentSelection = selectionContext === fingerprint ? selection : null;
  useEffect(() => { if (currentSelection) selector.current?.focus(); }, [currentSelection]);
  const machine = machines.find(item => item.id === selected);
  return <div className="machine-workspace">
    <section className="panel machine-selector">
      <label>{t('machines.title')}<select ref={selector} aria-label={t('machines.title')} value={selected} disabled={!currentSelection && !error} onChange={event => { const value = event.target.value; requestAppNavigation(() => void choose(value)); }}>
        <option value="">{t('machines.local')}</option>
        {machines.map(item => <option key={item.id} value={item.id}>{item.label} · {item.destination}</option>)}
        <option value="add">{t('machines.add')}</option>
      </select></label>
      <p>{t('machines.separate')}</p>
      {error ? <div role="alert">{error}<button type="button" className="secondary-button" onClick={() => { void choose(selected); void loadMachines(); }}>{t('common.retry')}</button></div> : null}
      {!currentSelection && !error ? <p role="status">{t('machines.switching')}</p> : null}
    </section>
    {currentSelection ? selected === 'add' ? <MachineEnrollment onSaved={item => { registryGeneration.current++; setMachines(items => [...items.filter(value => value.id !== item.id), item]); void choose(item.id); }} onBack={() => void choose('')} />
      : machine ? <RemoteMachinePanel key={`${machine.id}:${currentSelection.revision}`} machine={machine} selection={currentSelection} onBack={() => void choose('')} onRemove={async () => {
        await invoke('remove_remote_machine', { machineId: machine.id });
        registryGeneration.current++;
        setMachines(items => items.filter(item => item.id !== machine.id)); await choose('');
      }} /> : selected === '' ? children : null : null}
  </div>;
}

function MachineEnrollment({ onSaved, onBack }: { onSaved: (machine: Machine) => void; onBack: () => void }) {
  const { t } = useI18n();
  const [label, setLabel] = useState('');
  const [destination, setDestination] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(save: boolean) {
    setBusy(true); setError('');
    try {
      if (save && probe) {
        const machine = await invoke<Machine>('save_remote_machine', { label: label.trim(), destination: destination.trim(), identity: probe.identity });
        if (alive.current) onSaved(machine);
      } else {
        const result = await invoke<Probe>('probe_remote_machine', { destination: destination.trim() });
        if (alive.current) setProbe(result);
      }
    } catch (cause) { if (alive.current) { setError(String(cause)); setProbe(null); } }
    finally { if (alive.current) setBusy(false); }
  }
  return <section className="panel remote-machine-panel">
    <h2>{t('machines.add')}</h2><p>{t('machines.prerequisites')}</p><p>{t('machines.helper')}</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      <fieldset disabled={busy} className="machine-fields"><legend>{t('machines.transport')}</legend>
        <label>{t('machines.name')}<input required value={label} maxLength={100} onChange={event => setLabel(event.target.value)} /></label>
        <label>{t('machines.destination')}<input required value={destination} autoComplete="off" onChange={event => { setDestination(event.target.value); setProbe(null); }} /></label>
      </fieldset>
      <div className="button-row"><button type="button" className="secondary-button" onClick={onBack}>{t('machines.back')}</button><button type="submit" className="secondary-button" disabled={busy || !destination.trim()}>{t(busy ? 'common.processing' : 'machines.test')}</button><button type="button" className="primary-button" disabled={busy || !probe || !label.trim()} onClick={() => void run(true)}>{t('machines.enroll')}</button></div>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {probe ? <CapabilityDetails probe={probe} /> : null}
  </section>;
}

function CapabilityDetails({ probe, collapsed = false }: { probe: Probe; collapsed?: boolean }) {
  const { t } = useI18n();
  return <details className="machine-capabilities" open={!collapsed}><summary>{t('machines.capabilities')}</summary><p>{probe.os} / {probe.arch}</p><p>{t('machines.identity')}: <code>{probe.identity}</code></p><code>{probe.home}</code>
    <ul>{probe.clients.map(client => <li key={client.id}><strong>{client.name}</strong> — {client.supported ? t('machines.supported') : client.reason || t('common.unavailable')}<ul>{client.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></li>)}</ul>
    {probe.limits.map(limit => <p key={limit}>{limit}</p>)}
  </details>;
}

function RemoteMachinePanel({ machine, selection, onBack, onRemove }: { machine: Machine; selection: Selection; onBack: () => void; onRemove: () => Promise<void> }) {
  const { t } = useI18n();
  const { connection } = useCoreConnection();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [client, setClient] = useState('');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [origin, setOrigin] = useState(connection.clientApiOrigin);
  const [apiKey, setApiKey] = useState('');
  // ponytail: explicit model IDs only; add a picker when helper exposes a model catalog capability.
  const [model, setModel] = useState('');
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [preview, setPreview] = useState<{ backup: Backup; value: Preview } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice(''); setClearOpen(false);
    try { await work(); }
    catch (cause) { if (alive.current) { setError(String(cause)); setInspection(null); setPreview(null); setClearOpen(false); } }
    finally { if (alive.current) setBusy(false); }
  }
  const actionMessage = (result: ActionResult, success: string) => result.conflictFiles?.length ? t('machines.conflicts', { files: result.conflictFiles.join(', ') }) : success;
  const request = <T,>(operation: Record<string, unknown>) => invoke<T>('remote_machine_request', { machineId: machine.id, selectionRevision: selection.revision, coreRevision: selection.coreRevision, operation });
  async function inspect() {
    setClearOpen(false); setPreview(null);
    const next = await invoke<Probe>('probe_remote_machine', { destination: machine.destination });
    if (next.identity !== machine.identity) throw new Error(t('machines.identityChanged'));
    if (!alive.current) return;
    setProbe(next);
    const current = next.clients.find(item => item.id === client && item.supported) || next.clients.find(item => item.supported);
    if (!current) { setClient(''); setInspection(null); return; }
    setClient(current.id);
    const value = await invoke<Inspection>('remote_machine_request', { machineId: machine.id, selectionRevision: selection.revision, coreRevision: selection.coreRevision, operation: { kind: 'inspect', client: current.id } });
    if (alive.current) { setInspection(value); setModel(value.currentModel || ''); setPreview(null); setBackups(null); }
  }
  const ready = !!inspection && Number.isSafeInteger(selection.coreRevision) && probe?.clients.some(item => item.id === client && item.supported);
  const validConfig = ready && inspection?.configValid;
  const networkOrigin = isRemoteNetworkOrigin(origin.trim());
  const validTarget = networkOrigin && connection.mode === 'remote' && !!origin.trim() && !!apiKey && !!model.trim() && origin.trim() === connection.clientApiOrigin && apiKey === connection.clientApiKey;
  return <section className="panel remote-machine-panel" aria-label={machine.label}>
    <h2>{t('machines.target', { machine: machine.label })}</h2><code>{machine.destination}</code><p>{t('machines.limit')}</p>
    <div className="button-row"><button type="button" className="secondary-button" onClick={onBack}>{t('machines.back')}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void run(inspect)}>{t('machines.inspect')}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void run(onRemove)}>{t('machines.remove')}</button></div>
    <p role="status">{t(busy ? 'machines.busy' : inspection ? 'machines.ready' : 'machines.unknown')}</p>
    {error ? <div role="alert"><p>{error}</p><p>{t('machines.failed')}</p></div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {probe ? <CapabilityDetails probe={probe} collapsed /> : null}
    {inspection ? <p>{t(!inspection.configValid ? 'machines.invalidConfig' : inspection.configured ? 'machines.configured' : 'machines.notConfigured')}</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (!validConfig || !validTarget || busy) return; void run(async () => {
      const result = await request<ActionResult>({ kind: 'apply', client, revision: inspection!.revision, origin: origin.trim(), apiKey, model: model.trim() });
      if (alive.current) { setInspection(null); setPreview(null); setApiKey(''); setNotice(actionMessage(result, t('machines.applied') + ' ' + (result.changedFiles || []).join(', '))); }
    }); }}>
      <fieldset className="machine-fields" disabled={busy || !probe}><legend>{t('machines.client')}</legend>
        <label>{t('machines.client')}<select aria-label={t('machines.client')} value={client} onChange={event => { setClient(event.target.value); setClearOpen(false); setInspection(null); setPreview(null); setBackups(null); setModel(''); setNotice(''); }}><option value="">{t('machines.selectClient')}</option>{probe?.clients.map(item => <option key={item.id} value={item.id} disabled={!item.supported}>{item.name}{!item.supported ? ` — ${item.reason || t('common.unavailable')}` : ''}</option>)}</select></label>
        <label>{t('machines.model')}<input value={model} required onChange={event => setModel(event.target.value)} /></label>
        <label>{t('machines.origin')}<input value={origin} type="url" required onChange={event => setOrigin(event.target.value)} /></label>
        <label>{t('machines.key')}<input value={apiKey} type="password" required autoComplete="off" onChange={event => setApiKey(event.target.value)} /></label>
      </fieldset>
      {connection.mode !== 'remote' || !connection.clientApiOrigin || !connection.clientApiKey ? <p role="status">{t('machines.remoteCoreRequired')}</p> : null}
      <p>{t('machines.coreTarget', { origin: connection.clientApiOrigin || t('common.unavailable') })}</p>
      {origin.trim() && !networkOrigin ? <p role="status">{t('machines.networkOriginRequired')}</p> : null}
      <p>{t('machines.required')}</p>
      <button className="primary-button" type="submit" disabled={busy || !validConfig || !validTarget}>{t('machines.apply')}</button>
    </form>
    <div className="button-row"><button type="button" className="secondary-button" disabled={busy || !ready} onClick={() => void run(async () => {
      await request({ kind: 'backup', client, revision: inspection!.revision });
      if (alive.current) { setNotice(t('machines.backupCreated')); setBackups(null); setPreview(null); }
    })}>{t('machines.createBackup')}</button><button type="button" className="secondary-button" disabled={busy || !ready} onClick={() => void run(async () => { const value = await request<{ versions: Backup[] }>({ kind: 'backups', client }); if (alive.current) { setBackups(value.versions); setPreview(null); } })}>{t('machines.backups')}</button></div>
    <p>{t('machines.clearHint')}</p><button type="button" className="secondary-button" disabled={busy || !validConfig} onClick={() => { setClearOpen(true); setPreview(null); }}>{t('machines.clear')}</button>
    {clearOpen ? <section aria-label={t('machines.clear')}><p>{t('machines.clearConfirm', { machine: machine.label, client })}</p><button type="button" className="secondary-button" disabled={busy || !validConfig} onClick={() => void run(async () => {
      const result = await request<ActionResult>({ kind: 'clear', client, revision: inspection!.revision });
      if (alive.current) { setClearOpen(false); setInspection(null); setPreview(null); setApiKey(''); setBackups(null); setNotice(actionMessage(result, t('machines.cleared'))); }
    })}>{t('machines.confirmClear')}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setClearOpen(false)}>{t('common.cancel')}</button></section> : null}
    {backups ? <section><h3>{t('machines.backups')}</h3><p>{t('machines.sensitiveBackups')}</p>{!backups.length ? <p>{t('machines.noBackups')}</p> : <ul>{backups.map(backup => <li key={backup.id}><code>{backup.location}</code><span>{backup.createdAt}</span><button type="button" className="secondary-button" disabled={busy || !ready || !backup.restorable} onClick={() => void run(async () => { const value = await request<Preview>({ kind: 'preview', client, backupId: backup.id }); if (alive.current) setPreview({ backup, value }); })}>{t('machines.preview')}</button>{backup.error ? <p>{backup.error}</p> : null}</li>)}</ul>}</section> : null}
    {preview ? <section><h3>{t('machines.preview')}</h3><ul>{preview.value.files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul><ul>{preview.value.differences.map((difference, index) => <li key={index}><code>{difference.file}</code> — {difference.field} — {t('machines.backupChange', { before: difference.before, after: difference.after })}</li>)}</ul><p>{t('machines.restoreHint')}</p><button type="button" className="secondary-button" disabled={busy || !ready} onClick={() => void run(async () => { const result = await request<ActionResult>({ kind: 'restore', client, backupId: preview.backup.id, revision: preview.value.revision }); if (alive.current) { setInspection(null); setPreview(null); setNotice(actionMessage(result, t('machines.restored'))); } })}>{t('machines.restore')}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setPreview(null)}>{t('common.cancel')}</button></section> : null}
  </section>;
}
