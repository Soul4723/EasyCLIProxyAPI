// Pure sign-in helpers shared by useOAuthSignIn, the old OAuthLoginPage and the bun tests. No React, no Tauri.
import { validateDevinCallback } from '../../../services/devinOAuth';

export type OAuthBrowserOption = { id: string; label: string };

/** Built-in OAuth providers in display order; `callback` = the flow can finish by pasting the final callback URL. */
export const BUILTIN_OAUTH_PROVIDERS = [
  { id: 'codex', callback: true },
  { id: 'claude', callback: true },
  { id: 'antigravity', callback: true },
  { id: 'kimi', callback: false },
  { id: 'xai', callback: false },
  { id: 'devin', callback: true },
  { id: 'meta', callback: false },
] as const;

export type BuiltInOAuthId = (typeof BUILTIN_OAUTH_PROVIDERS)[number]['id'];
export const BUILTIN_OAUTH_IDS: readonly string[] = BUILTIN_OAUTH_PROVIDERS.map((provider) => provider.id);
export const VERTEX_PROVIDER_ID = 'vertex';

export const OAUTH_POLL_INTERVAL_MS = 3000;
export const OAUTH_BROWSER_STORAGE_KEY = 'easy-cli-proxy-api.oauth-browser.v3';
export const NO_AUTO_OPEN_BROWSER_ID = 'none';
/** Plugin sign-in sessions never outlive this, whatever the core reports. */
export const PLUGIN_SESSION_MAX_MS = 30 * 60 * 1000;
export const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';

export const resolveOAuthBrowserSelection = (
  available: OAuthBrowserOption[],
  preferred: string,
): string => {
  if (preferred === NO_AUTO_OPEN_BROWSER_ID) return preferred;
  if (available.some((browser) => browser.id === preferred)) return preferred;
  return available.find((browser) => browser.id !== 'default')?.id
    ?? available.find((browser) => browser.id === 'default')?.id
    ?? NO_AUTO_OPEN_BROWSER_ID;
};

export const loadOAuthBrowserPreference = (): string => {
  try {
    return window.localStorage.getItem(OAUTH_BROWSER_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

/** Browser id for open_oauth_url: "do not open automatically" still opens the default browser on an explicit click. */
export const openBrowserId = (selected: string): string =>
  selected === NO_AUTO_OPEN_BROWSER_ID ? 'default' : selected || 'default';

const isAbsoluteUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const readQueryLikeCallbackInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams = queryStart >= 0
    ? trimmed.slice(queryStart + 1)
    : hashStart >= 0
      ? trimmed.slice(hashStart + 1)
      : trimmed;
  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
};

export const buildXaiCallbackUrl = (input: string, state?: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  const params = readQueryLikeCallbackInput(trimmed);
  if (params) {
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;
    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    for (const key of ['code', 'error', 'error_description']) {
      const value = params.get(key)?.trim();
      if (value) callbackUrl.searchParams.set(key, value);
    }
    return callbackUrl.toString();
  }
  const code = (trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i)?.[1] ?? trimmed).trim();
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;
  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
};

export const resolveCallbackUrl = (provider: string, input: string, state?: string): string | null =>
  provider === 'xai' ? buildXaiCallbackUrl(input, state) : input.trim();

export type CallbackCheck =
  | { ok: true; redirectUrl: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'state_mismatch' };

/**
 * Validates a pasted callback before it is sent. Built-in providers keep the old page rules (Devin: strict URL with
 * the current state; xAI: a bare code or query string is rebuilt into the loopback callback). Plugin providers
 * require a URL carrying the current state plus a code or error, as PluginOAuthDialog did.
 */
export const checkCallbackInput = (
  provider: string,
  input: string,
  state: string | undefined,
  plugin = false,
): CallbackCheck => {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (plugin) {
    try {
      const url = new URL(trimmed);
      const params = url.searchParams;
      if (params.get('state') !== state
        || !(params.get('code')?.trim() || params.get('error')?.trim() || params.get('error_description')?.trim())) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, redirectUrl: trimmed };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }
  if (provider === 'devin') {
    const error = validateDevinCallback(trimmed, state);
    if (error) return { ok: false, reason: error === 'state_mismatch' ? 'state_mismatch' : 'invalid' };
  }
  const redirectUrl = resolveCallbackUrl(provider, trimmed, state);
  return redirectUrl ? { ok: true, redirectUrl } : { ok: false, reason: 'invalid' };
};

/** Splits an authorization URL so the dialog can highlight the host the user is about to visit. */
export const splitAuthUrl = (value: string): { scheme: string; host: string; rest: string } => {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i.exec(value.trim());
  return match
    ? { scheme: match[1], host: match[2], rest: match[3] }
    : { scheme: '', host: '', rest: value };
};

export const isHttpUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
