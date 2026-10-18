// Single entry point for Tauri platform access outside services/mocks (upstream #481 contract).
export { invoke, isTauri } from '@tauri-apps/api/core';
export type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';
export { listen } from '@tauri-apps/api/event';
export type { UnlistenFn } from '@tauri-apps/api/event';
export { getCurrentWebview } from '@tauri-apps/api/webview';
export { getCurrentWindow } from '@tauri-apps/api/window';
export { getVersion } from '@tauri-apps/api/app';
export { open, save } from '@tauri-apps/plugin-dialog';
