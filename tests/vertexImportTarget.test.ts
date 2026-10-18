import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { importVertexCredential } from '../src/services/vertexImport';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeAll(() => Object.defineProperty(globalThis, 'window', { value: {}, configurable: true }));
afterEach(() => clearMocks());
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('Vertex import captures A before reading and rejects B without uploading', async () => {
  let revision = 7;
  let uploads = 0;
  const revisions: unknown[] = [];
  mockIPC((command, args) => {
    if (command === 'get_management_target_revision') return revision;
    if (command === 'import_vertex_credential') {
      revisions.push(args!.expectedRevision);
      if (args!.expectedRevision !== revision) throw new Error('Core connection changed; upload cancelled');
      uploads++;
      return { status: 'ok' };
    }
    throw new Error(command);
  });
  const file = new File(['{}'], 'account.json');
  file.arrayBuffer = async () => {
    revision = 8; // Native A -> B, before any browser connection-change event.
    return new TextEncoder().encode('{}').buffer;
  };
  await expect(importVertexCredential(file, '')).rejects.toThrow('upload cancelled');
  expect(revisions).toEqual([7]);
  expect(uploads).toBe(0);
});

test('Vertex import preserves bytes, location and response for the captured target', async () => {
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === 'get_management_target_revision') return 7;
    if (command === 'import_vertex_credential') return {
      status: 'ok', project_id: 'project', email: 'account@example.invalid',
      location: 'us-central1', 'auth-file': 'vertex-project.json',
    };
    throw new Error(command);
  });
  expect(await importVertexCredential(new File(['{}'], 'account.json'), ' us-central1 ')).toEqual({
    projectId: 'project', email: 'account@example.invalid', location: 'us-central1', authFile: 'vertex-project.json',
  });
  expect(calls).toEqual([
    { command: 'import_vertex_credential', args: {
      name: 'account.json', data: [123, 125], expectedRevision: 7, location: 'us-central1',
    } },
  ]);
});
