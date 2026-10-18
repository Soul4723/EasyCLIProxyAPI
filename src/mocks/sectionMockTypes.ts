export type SectionMockResult = { handled: false } | { handled: true; value: unknown };

/** Subset of the runtime state a section mock may read/mutate (it is the same object browserMockRuntime uses). */
export type SectionMockHost = {
  scenario: 'running' | 'stopped' | 'empty' | 'error';
  [key: string]: unknown;
};

export type SectionMockHandler = {
  /** `command` is the Tauri command name; `management_request` carries {method, path, body} in `payload`. */
  handle(command: string, payload: Record<string, unknown>): SectionMockResult;
};

/** Called once per mock runtime (so state is per page load / scenario). */
export type SectionMockFactory = (host: SectionMockHost) => SectionMockHandler;
