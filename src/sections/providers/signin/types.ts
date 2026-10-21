import type { ReactNode } from 'react';
import type { OAuthBrowserOption } from './logic';

export type SignInProvider = {
  id: string;
  /** Brand id for logos, colours and the provider detail link (`#/providers?p=<brand>`). Plugin providers use their own id. */
  brand: string;
  name: string;
  kind: 'oauth' | 'vertex' | 'plugin';
  /** The flow can also be finished by pasting the final callback URL. */
  callbackSupported: boolean;
  disabledReason?: string;
};

export type SignInFlowState = 'idle' | 'waiting' | 'success' | 'error';

/** Per-provider flow state (what the old OAuthLoginPage kept in its `states` map). */
export type FlowState = {
  status: SignInFlowState;
  url?: string;
  userCode?: string;
  state?: string;
  error?: string;
  /** A poll loop is running (also true while the link is being generated). */
  polling?: boolean;
  /** Device flows finish on the core: no callback step. */
  device?: boolean;
  /** Plugin sessions only: epoch ms after which the link is dead. */
  expiresAt?: number;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
  refreshing?: boolean;
  /** Non-fatal message under the steps (browser could not be opened, the previous session could not be cancelled). */
  notice?: { tone: 'info' | 'error'; text: string };
  /** Sign-in worked but the new credential's priority could not be set to 0. */
  priorityError?: string;
};

/** What SignInDialog renders and drives for the provider that is currently open. */
export type SignInSession = {
  provider: SignInProvider;
  flow: FlowState;
  setCallbackUrl: (value: string) => void;
  submitCallback: () => void;
  refreshLink: () => void;
  openLink: () => void;
  /** Starts a fresh attempt for the same provider (retry after a failure, "sign in another account"). */
  restart: () => void;
  close: () => void;
};

export type OAuthSignInController = {
  providers: SignInProvider[];
  browsers: OAuthBrowserOption[];
  browsersLoading: boolean;
  selectedBrowser: string;
  setBrowser: (id: string) => void;
  /** Opens the flow dialog for the provider and begins (or re-shows a flow that is already waiting). */
  start: (providerId: string) => void;
  activeProviderId: string | null;
  flowState: (providerId: string) => SignInFlowState;
  /** Remote core: the browser redirect cannot reach the core, so pasting the callback is the primary path. */
  remote: boolean;
  /** Plugin sign-in options could not be loaded (built-in providers keep working). */
  pluginError: boolean;
  reload: () => void;
  session: SignInSession | null;
  /** Render once, anywhere in the page: SignInDialog + VertexImportDialog. */
  dialogs: ReactNode;
};

export type SignInDialogController = Omit<OAuthSignInController, 'dialogs'>;
