// Test helper for the quota section: build a QuotaAccount from a credential + quota snapshot and render
// the account card / row as static markup (no popover, no side panel — those are portaled).
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../src/i18n';
import type { ControlsContext, QuotaActions } from '../../src/sections/quota/AccountControls';
import { AccountCard, AccountRow } from '../../src/sections/quota/AccountItem';
import { buildAccount, type QuotaAccount } from '../../src/sections/quota/model';
import type { LightingApi } from '../../src/sections/quota/useLighting';
import type { AuthFile, QuotaState } from '../../src/services/quotaService';

const noop = () => {};
export const stubActions = (overrides: Partial<QuotaActions> = {}): QuotaActions => ({
  open: noop, refresh: noop, setEnabled: noop, consume: noop, clearCooldown: noop, openLighting: noop, ...overrides,
});

export const stubLighting = (overrides: Partial<LightingApi> = {}): LightingApi => ({
  available: true, loading: false, error: null, status: null, schedules: new Map(),
  capabilityFor: () => undefined, scheduleFor: () => undefined,
  reload: async () => {}, save: async (schedule) => schedule, setEnabled: async (schedule) => schedule,
  remove: async () => {}, runNow: async () => { throw new Error('not used'); }, reportObserved: noop,
  ...overrides,
});

export const NOW = Date.parse('2030-01-01T12:00:00Z');

/** `file` needs at least { name, provider }; auth_index defaults so the account can refresh. */
export function accountFor(file: AuthFile, quota: QuotaState, now = NOW): QuotaAccount {
  const account = buildAccount({ auth_index: 'test-index', ...file }, quota, now, 'en', { receivedAtMs: now });
  if (!account) throw new Error('Not a quota provider credential');
  return account;
}

export function context(overrides: Partial<ControlsContext> = {}): ControlsContext {
  return { now: NOW, lighting: stubLighting(), actions: stubActions(), busyKeys: new Set(), ...overrides };
}

export function renderCard(
  file: AuthFile,
  quota: QuotaState,
  options: { ctx?: Partial<ControlsContext>; grouped?: boolean; selected?: boolean } = {},
): string {
  const account = accountFor(file, quota);
  return renderToStaticMarkup(
    <I18nProvider>
      <AccountCard account={account} ctx={context(options.ctx)} selected={options.selected ?? false} grouped={options.grouped} />
    </I18nProvider>,
  );
}

export function renderRow(file: AuthFile, quota: QuotaState, options: { ctx?: Partial<ControlsContext> } = {}): string {
  const account = accountFor(file, quota);
  return renderToStaticMarkup(
    <I18nProvider>
      <AccountRow account={account} ctx={context(options.ctx)} selected={false} />
    </I18nProvider>,
  );
}
