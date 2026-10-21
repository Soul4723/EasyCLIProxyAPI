# Tests

Run commands from the repository root. Bun discovers nested `*.test.ts`,
`*.test.tsx` and `*.test.cjs` files automatically; no custom discovery config is needed.

## Layout

```text
tests/
├── unit/<area>/        Bun logic, service, rendering and source-contract tests
├── ui/<section>/       Headless Playwright *-ui.cjs scripts
├── helpers/            Shared harnesses, IPC/fixture helpers and render utilities
├── fixtures/           Vite HTML/React entry points and static test data
├── manual/             Opt-in live integration scripts and native probes
├── run-ui.cjs          Recursive, serial UI runner
└── run-all.cjs         Typecheck, build, Bun, Rust and whole UI suite
```

Areas follow the app: `overview`, `providers`, `quota`, `usage`, `agents`,
`plugins`, `settings`, plus `shell`, `ui-kit`, `services`, `platform` and `mocks`.
Section-specific service tests live with their section; cross-section services live
in `services`. Rust tests remain in `src-tauri/`: crate-level tests that span modules live in `src-tauri/src/tests/` (declared by `src-tauri/src/tests.rs`), while a split module keeps its unit tests in a sibling `tests.rs` (for example `usage/tests.rs`) and small files use an inline `mod tests`; run them with `(cd src-tauri && cargo test --bin cpa-gui)`.

## Run

```sh
bun test --isolate                        # all Bun tests (bun run test is equivalent)
bun test --isolate tests/unit/providers   # one area during development
node tests/run-ui.cjs                     # WHOLE UI suite
node tests/run-ui.cjs usage theme         # filename substring matches (OR), recursively
bun run test:all                          # all five stages, including Rust
(cd src-tauri && cargo test --bin cpa-gui) # Rust only
```

Run the **whole UI suite before merging every frontend PR**. Filtered runs are
useful while editing, but do not replace the whole suite: another section can regress.
UI scripts run one at a time and start/close their own Vite server and browser.
Fixtures remain served at `/tests/fixtures/*.html`; moving a script does not change
those URLs.

Install Playwright and its Chromium browser, or point `PLAYWRIGHT_MODULE` at an
existing installation. `PLAYWRIGHT_CHANNEL` selects an installed browser such as
`chrome` or `msedge`; otherwise bundled Chromium is used (some legacy harnesses
use Edge by default on Windows). For example:

```sh
PLAYWRIGHT_MODULE=/absolute/path/node_modules/playwright node tests/run-ui.cjs
PLAYWRIGHT_CHANNEL=chrome node tests/run-ui.cjs settings-connection
```

`manual/claude-code-live.cjs` runs installed Claude Code against an explicitly
configured **test** core and reads the local Claude settings. It is not a mock test.
`manual/antigravity-native-probe.py --help` describes its required installed-binary
arguments; it exercises native launch helpers against a disposable mock API.
Neither runs in any automated suite. Use an isolated lab with test credentials,
never an owner's live core or account.

## Add a test

- Put Bun tests in `unit/<area>/`, using `camelCase.test.ts` (or `.tsx` for JSX).
  The Copilot setup helper uses `.test.cjs` because it tests CommonJS code.
- Put browser scripts in `ui/<section>/`, using `kebab-case-ui.cjs`. Reuse
  `helpers/shell.cjs`, `helpers/ui-harness.cjs` or the focused fixture helpers.
  The runner discovers new scripts recursively; do not add a per-file package script.
- Keep shared fixtures in `fixtures/` and shared helpers in `helpers/`. Resolve
  imports and repository-root paths from the file's actual directory. Vite fixture
  URLs are repository-root-relative, not script-relative.
- Put opt-in live/probe tools in `manual/`, without a `.test.*` or `-ui.cjs` suffix.

## Mock contracts

`unit/mocks/{browserMockRuntime,browserMockQuota,lightingMock,pluginMock}.test.ts`
guard protocols consumed by the real UI: lifecycle/revision fencing, quota parsing
and credential edits, lighting commands/events, and plugin routes/webview ownership.
`unit/mocks/fencedCommands.test.ts` guards native-style rejection of missing revision
arguments. Keep these contracts; they are not tests of unconsumed mock internals.
`unit/settings/templateConfig.test.ts` additionally checks production template logic
and its mock round-trip. No mock-only tests were deleted in this reorganisation.
See [the mock runtime guide](../src/mocks/README.md) for the rationale and scenarios.

Green mock tests do not establish native backend correctness. For real-app
observation see [the headless observation guide](../docs/dev-observe.md).
