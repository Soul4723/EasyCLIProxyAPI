import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

type DraftConnection = { mode?: string; managementOrigin?: string; managementKey?: string };

/**
 * Browser-mock handlers owned by the settings section (see src/mocks/sectionMocks.ts).
 * `test_core_connection` answers with the same messages the Rust command returns so the Connection tab can show every
 * mapped failure. Fixture hosts: `offline` → unreachable, `forbidden` → HTTP 403, `legacy` → no v8 API, `broken` → HTTP 500;
 * any other host answers 401 unless the management key is `fixture-management-key`.
 */
export const settingsMock: SectionMockFactory = () => ({
  handle(command, payload) {
    if (command !== 'test_core_connection') return { handled: false };
    const connection = (payload as { connection?: DraftConnection }).connection ?? {};
    if (connection.mode !== 'remote') throw new Error('Connection testing is only available for remote drafts');
    const origin = connection.managementOrigin ?? '';
    const fail = (message: string) => ({ handled: true as const, value: { connected: false, version: null, message } });
    if (origin.includes('offline')) return fail('Unable to reach the core');
    if (origin.includes('forbidden')) return fail('Remote management access is forbidden');
    if (origin.includes('legacy')) return fail('Core does not expose the v8 management API');
    if (origin.includes('broken')) return fail('Core management request failed (HTTP 500)');
    if (connection.managementKey !== 'fixture-management-key') return fail('Core rejected the management key');
    return { handled: true as const, value: { connected: true, version: '8.0.29', message: 'Connected' } };
  },
});
