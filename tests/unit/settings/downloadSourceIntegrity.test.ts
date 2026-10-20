// Download sources: mirrors are an explicit opt-in and the saved source is never switched behind the user's back.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBrowserMockRuntime } from '../../../src/mocks/browserMockRuntime';
import { localizeInstallPhase } from '../../../src/sections/settings/updates/model';
import { updatesEn, updatesJa, updatesZhCN } from '../../../src/sections/settings/strings/updates';

const read = (file: string) => readFileSync(new URL(`../../../src/sections/settings/${file}`, import.meta.url), 'utf8');

describe('download source integrity UI', () => {
  it('no longer reacts to an automatic source switch', () => {
    const hook = read('updates/useVersionSource.ts');
    expect(hook).not.toContain('version-download-source-changed');
    expect(hook).not.toContain('sourceAutoSwitched');
  });

  it('saves mirror fallback only through set_mirror_fallback from the toggle', () => {
    const hook = read('updates/useVersionSource.ts');
    expect(hook.match(/invoke<VersionSourceSettings>\('set_mirror_fallback', \{ enabled \}\)/g)).toHaveLength(1);
    const view = read('updates/DownloadSources.tsx');
    expect(view).toContain("checked={settings?.mirrorFallback ?? false}");
    expect(view).toContain('onChange={onMirrorFallback}');
    expect(read('tabs/UpdatesTab.tsx')).toContain('onMirrorFallback={(enabled) => void sources.setMirrorFallback(enabled)}');
  });

  it('mock runtime keeps mirror fallback off until opted in and never changes the source', async () => {
    const runtime = createBrowserMockRuntime('running');
    const initial = await runtime.invoke('get_version_source_settings', {}) as { source: string; mirrorFallback: boolean };
    expect(initial.mirrorFallback).toBe(false);
    const on = await runtime.invoke('set_mirror_fallback', { enabled: true }) as { source: string; mirrorFallback: boolean };
    expect(on).toMatchObject({ source: initial.source, mirrorFallback: true });
    const off = await runtime.invoke('set_mirror_fallback', { enabled: false }) as { mirrorFallback: boolean };
    expect(off.mirrorFallback).toBe(false);
  });

  it('has copy for the opt-in and the checksum note in every locale', () => {
    for (const strings of [updatesZhCN, updatesEn, updatesJa]) {
      for (const key of [
        'sec.settings.updates.sources.integrityNote',
        'sec.settings.updates.sources.fallbackLabel',
        'sec.settings.updates.sources.fallbackHint',
        'sec.settings.updates.sources.fallbackSaveFailed',
      ] as const) expect(strings[key].length).toBeGreaterThan(0);
    }
    expect(updatesEn['sec.settings.updates.sources.integrityNote']).toContain('GitHub');
  });

  it('labels the official checksum phase', () => {
    const t = (key: string) => key;
    expect(localizeInstallPhase('Fetching official checksums', t as never)).toBe('kernel.phase.fetchingChecksums');
  });
});
