import { invoke } from './platform';
import { open } from '@tauri-apps/plugin-dialog';

/** Native plugin libraries the core can load. */
export const LOCAL_PLUGIN_EXTENSIONS = ['dll', 'so', 'dylib'];
export const PLUGIN_DEVELOPMENT_GUIDE_URL = 'https://help.router-for.me/cn/plugin/development.html';

export const localPluginFileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** Native file picker for a plugin library; null when cancelled. */
export async function chooseLocalPluginFile(title: string, filterName: string): Promise<string | null> {
  const selected = await open({ multiple: false, directory: false, title, filters: [{ name: filterName, extensions: LOCAL_PLUGIN_EXTENSIONS }] });
  return typeof selected === 'string' && selected ? selected : null;
}

/** Copies the file into the plugin directory (never overwrites); resolves with the installed path. */
export const installLocalPlugin = (source: string): Promise<string> => invoke<string>('install_local_plugin', { source });
