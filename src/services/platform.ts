// Single entry point for Tauri platform access outside services/mocks (upstream #481 contract).
import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { documentTarget } from './documentTarget';
import { isFencedCommand } from './fencedCommands';

/** Fenced commands always bind the document's target, including nested management requests. */
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
