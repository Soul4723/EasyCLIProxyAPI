import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

type Transport = typeof nativeInvoke;
const changed = () => new Error('The core connection changed; reload before continuing');

/** One WebView document owns one revision. Never refresh it for a later request. */
export function createDocumentTarget(transport: Transport) {
  let revision: Promise<number> | undefined;
  let revisionOwner: unknown;
  let blocked = false;
  const getRevision = () => {
    // Test harnesses can replace the mocked WebView between documents. A real
    // document keeps one stable global, so this does not alter production fencing.
    const owner = (globalThis as { window?: unknown }).window;
    if (owner !== revisionOwner) {
      revisionOwner = owner;
      revision = undefined;
    }
    return revision ??= transport<number>('get_management_target_revision').then(value => {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid core target revision');
      return value;
    });
  };
  const assertActive = () => { if (blocked) throw changed(); };
  return {
    getRevision,
    block: () => { blocked = true; },
    restore: () => { blocked = false; },
    async invoke<T>(command: string, args: InvokeArgs = {}, options?: InvokeOptions): Promise<T> {
      assertActive();
      const expectedRevision = await getRevision();
      assertActive();
      if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) throw new Error('Target commands require named arguments');
      const payload = args as Record<string, unknown>;
      const supplied = command === 'management_request'
        ? (payload.request as Record<string, unknown> | undefined)?.expectedRevision : payload.expectedRevision;
      if (supplied !== undefined && supplied !== expectedRevision) throw changed();
      const bound = command === 'management_request'
        ? { ...payload, request: { ...(payload.request as object), expectedRevision } }
        : { ...payload, expectedRevision };
      const result = await transport<T>(command, bound, options);
      assertActive();
      return result;
    },
  };
}

export const documentTarget = createDocumentTarget(nativeInvoke);
export const invoke = documentTarget.invoke;
