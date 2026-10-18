import { documentTarget } from './documentTarget';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';

/**
 * The Usage section's only door to Tauri: usage commands (get_usage_*, save_usage_*, *_usage_*, resume_usage_collection,
 * get_core_config_settings), the `usage-records-updated` event and the CSV save dialog. The browser mock answers the commands. Calls go through the document target, which binds the revision that get_core_config_settings and resume_usage_collection require.
 */
export const invoke = <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => documentTarget.invoke<T>(command, args);

/** Subscribes to collector updates; resolves to the unsubscribe function. */
export const onUsageRecordsUpdated = (handler: () => void): Promise<() => void> => listen('usage-records-updated', handler);

/** Asks where to save the exported CSV (null = cancelled). */
export const chooseUsageExportPath = (options: { title: string; defaultPath: string; fileType: string }): Promise<string | null> =>
  save({ title: options.title, defaultPath: options.defaultPath, filters: [{ name: options.fileType, extensions: ['csv'] }] });
