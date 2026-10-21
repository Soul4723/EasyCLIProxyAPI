// Single entry point for Tauri platform access outside services/mocks (upstream PR #481 controls/theme refactor: UI code uses this bridge instead of direct Tauri imports).
import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { createDocumentTarget } from './documentTarget';
import { isFencedCommand } from './fencedCommands';

export const documentTarget = createDocumentTarget(nativeInvoke);
export const invokeTarget = documentTarget.invoke;
export const isDocumentTargetBlocked = documentTarget.isBlocked;
// Read-only identity validation must check native state without rebinding this document.
export const checkTargetRevision = () => nativeInvoke<number>('get_management_target_revision');

/** Fencing binds calls to this document's core-target revision, rejecting stale calls/responses.
 * See docs/remote-core.md, “Fencing and revision semantics”, including nested management requests. */
export const invoke: typeof nativeInvoke = (command, args, options) =>
  isFencedCommand(command) ? documentTarget.invoke(command, args, options) : nativeInvoke(command, args, options);

export { isTauri } from '@tauri-apps/api/core';
export type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
export { listen } from '@tauri-apps/api/event';
export type { UnlistenFn } from '@tauri-apps/api/event';
export { getCurrentWebview } from '@tauri-apps/api/webview';
export { getCurrentWindow } from '@tauri-apps/api/window';
export { getVersion } from '@tauri-apps/api/app';
export { open, save } from '@tauri-apps/plugin-dialog';
