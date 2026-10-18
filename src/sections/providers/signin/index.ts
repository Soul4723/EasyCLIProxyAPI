// Public surface of the Providers sign-in package (OAuth flows, Vertex import, plugin OAuth providers).
export { useOAuthSignIn, type UseOAuthSignInOptions } from './useOAuthSignIn';
export { SignInDialog } from './SignInDialog';
export { BrowserPicker, type BrowserPickerProps } from './BrowserPicker';
export { VertexImportDialog, type VertexImportDialogProps } from './VertexImportDialog';
export type {
  FlowState,
  OAuthSignInController,
  SignInDialogController,
  SignInFlowState,
  SignInProvider,
  SignInSession,
} from './types';
export { BUILTIN_OAUTH_IDS, VERTEX_PROVIDER_ID } from './logic';
