import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function document() {
  const modules: Record<string, any> = {};
  const sent: { command: string; args: any }[] = [];
  let nativeRevision = 7;
  function load(name: string): any {
    if (modules[name]) return modules[name];
    const exports = {};
    const source = fs.readFileSync(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, Uint8Array, TextDecoder, require(id: string) {
      if (id === '@tauri-apps/api/core') return { invoke: async (command: string, args: any) => {
        sent.push({ command, args });
        const revision = command === 'management_request' ? args.request.expectedRevision : args.expectedRevision;
        if (revision !== nativeRevision) throw 'STALE_TARGET: Core connection changed';
        return command === 'import_vertex_credential' ? { status: 'ok' } : {};
      } };
      if (id === '../i18n') return { getCurrentLocale: () => 'en', translate: (_: string, key: string) => key };
      if (id.startsWith('./')) return load(id.slice(2));
      throw Error(id);
    } });
    return modules[name] = exports;
  }
  load('targetInvoke').initializeTargetRevision(7);
  return { load, sent, switchNative: () => { nativeRevision = 8; } };
}

function delayedFile(name: string) {
  let finish!: (buffer: ArrayBuffer) => void;
  let reads = 0;
  const file = { name, arrayBuffer: () => { reads++; return new Promise<ArrayBuffer>(resolve => { finish = resolve; }); } };
  return { file, reads: () => reads, finish: () => finish(new TextEncoder().encode('{}').buffer) };
}

test('pending auth-file read rejects after target invalidation and stops the upload batch', async () => {
  const doc = document();
  const first = delayedFile('first.json'), second = delayedFile('second.json');
  const batch = doc.load('managementApi').uploadAuthFiles([first.file, second.file]);
  doc.switchNative();
  doc.load('connectionGeneration').beginConnectionChange();
  first.finish();
  await expect(batch).rejects.toThrow('Core connection changed');
  expect(doc.sent).toHaveLength(0);
  expect(second.reads()).toBe(0);
});

test('pending imports carry document revision across native save/event-delivery gap', async () => {
  for (const vertex of [false, true]) {
    const doc = document(), file = delayedFile('secret.json');
    const result = vertex ? doc.load('vertexImport').importVertexCredential(file.file, '') : doc.load('managementApi').uploadAuthFiles([file.file, delayedFile('later.json').file]);
    doc.switchNative(); // no frontend event yet
    file.finish();
    await expect(result).rejects.toThrow('Core connection changed');
    expect(doc.sent).toHaveLength(1);
    expect(doc.sent[0].args.expectedRevision).toBe(7);
  }
});

test('late writes and plugin install retain immutable document revision', async () => {
  const doc = document();
  doc.switchNative();
  await expect(doc.load('managementApi').managementApi.patch('/config', {})).rejects.toThrow('Core connection changed');
  expect(doc.sent[0].args.request.expectedRevision).toBe(7);
});

test('save failure resumes work without rebinding the document revision', async () => {
  const doc = document(), generation = doc.load('connectionGeneration');
  generation.beginConnectionChange();
  generation.restoreConnectionAfterSaveFailure();
  await doc.load('managementApi').managementApi.get('/config');
  expect(doc.sent[0].args.request.expectedRevision).toBe(7);
  expect(() => doc.load('targetInvoke').initializeTargetRevision(8)).toThrow('Core connection changed');
});
