import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../../src/i18n';
import { canCheckCoreUpdates } from '../../../src/coreUpdate';
import type { CoreStatus } from '../../../src/coreRuntime';
import { CoreVersionCard } from '../../../src/sections/settings/updates/VersionCards';

const status: CoreStatus = {
  connectionMode: 'remote', installed: true, running: true, ready: true,
  starting: false, managed: false, processId: null, currentVersion: '8.0.32',
  installDir: '', binaryPath: null, message: '',
};

test('Local-only checks wait for status and never run for Remote', () => {
  expect(canCheckCoreUpdates(null)).toBe(false);
  expect(canCheckCoreUpdates(status)).toBe(false);
  expect(canCheckCoreUpdates({ ...status, connectionMode: 'local' })).toBe(true);
});

test('Remote core card shows host version without local update controls or stale failures', () => {
  const html = renderToStaticMarkup(<I18nProvider><CoreVersionCard
    status={status} remote latest={{ version: '8.0.33', assetName: 'local.zip' }}
    latestError="Local-only rejection" checking hasUpdate installing={false}
    progress={null} cancelling={false} bundled={null} bundledError=""
    onCheck={() => {}} onInstall={() => {}} onUseBundled={() => {}}
    onCancel={() => {}} onDismiss={() => {}}
  /></I18nProvider>);
  expect(html).toContain('8.0.32');
  expect(html).not.toContain('8.0.33');
  expect(html).not.toContain('Local-only rejection');
  expect(html).not.toContain('<button');
  expect(html).toContain('ec-upd-note');
});
