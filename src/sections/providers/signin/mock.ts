import type { SectionMockFactory, SectionMockHost } from '../../../mocks/sectionMockTypes';

/**
 * Scripted OAuth behaviour for the browser mock. Without `window.__ecSigninMock` nothing here is active and the shared
 * mock answers (start -> immediate ok on the first poll). Setting the object lets a preview page or a test drive the
 * states a real core produces: slow link generation, device codes, "still waiting", failures, rejected callbacks.
 */
export type SigninMockControl = {
  /** Delay before start_oauth_login answers (link-generating state). */
  startDelayMs?: number;
  startError?: string;
  userCode?: string;
  /** 'device' | 'authorization_code' */
  flow?: string;
  expiresIn?: number;
  /** start_oauth_login reports that the browser could not be opened. */
  openFailed?: boolean;
  /** get_oauth_status answer: 'wait' (default), 'error', or 'ok' (the shared mock then writes a credential). */
  status?: 'wait' | 'ok' | 'error';
  statusError?: string;
  /** submit_oauth_callback rejects with this message. */
  callbackError?: string;
};

declare global {
  interface Window {
    __ecSigninMock?: SigninMockControl;
  }
}

const control = (): SigninMockControl | undefined => (typeof window === 'undefined' ? undefined : window.__ecSigninMock);

/** Browser-mock handlers for the signin part of Providers; chained from ../mock.ts. */
export const signinMock: SectionMockFactory = (host: SectionMockHost) => {
  let counter = 0;
  return {
    handle(command, payload) {
      const script = control();
      if (!script) return { handled: false };

      if (command === 'start_oauth_login') {
        const provider = String(payload.provider ?? 'codex');
        const state = `mock-oauth-${provider}-${++counter}-${Date.now()}`;
        const answer = () => {
          if (script.startError) throw new Error(script.startError);
          (host.oauthSessions as Map<string, string> | undefined)?.set(state, provider);
          return {
            url: `https://auth.example.com/oauth/authorize?client_id=mock&state=${state}&scope=openid`,
            state,
            userCode: script.userCode ?? null,
            flow: script.flow ?? (script.userCode ? 'device' : 'authorization_code'),
            expiresIn: script.expiresIn ?? null,
            opened: !script.openFailed,
            openError: script.openFailed ? 'No browser found' : null,
          };
        };
        const delay = script.startDelayMs ?? 0;
        return {
          handled: true,
          value: delay > 0 ? new Promise((resolve, reject) => {
            window.setTimeout(() => { try { resolve(answer()); } catch (error) { reject(error); } }, delay);
          }) : answer(),
        };
      }

      if (command === 'get_oauth_status') {
        if (script.status === 'wait' || script.status === undefined) return { handled: true, value: { status: 'wait' } };
        if (script.status === 'error') {
          return { handled: true, value: { status: 'error', error: script.statusError ?? 'Authorization was denied' } };
        }
        return { handled: false };
      }

      if (command === 'submit_oauth_callback' && script.callbackError) {
        throw new Error(script.callbackError);
      }
      return { handled: false };
    },
  };
};
