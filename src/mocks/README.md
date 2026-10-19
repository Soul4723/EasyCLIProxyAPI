# Browser preview mocks

Run `bun run dev` and open the Vite URL in a regular browser. Mock IPC is installed
only in browser development builds; Tauri and production builds use the real backend.
No backend or upstream account is required. Data is fictional and mutations are
in memory, isolated per page load, except the active connection, its revision and saved
local process snapshot, which survive reload in per-tab session storage. Use
**Reset mock data** to reset the fixture.

Use the bottom toolbar or query parameters:

| URL option | Scenario |
| --- | --- |
| `?mock=running` | Running core, configured providers, usage records and mixed credential states |
| `?mock=stopped` | Installed but stopped core; start it to explore the populated pages |
| `?mock=empty` | Uninstalled core with empty credentials, providers and usage; install/start it to inspect empty states |
| `?mock=error` | Main backend reads fail so error and retry UI can be inspected |
| `?mock=off` | Disable mock IPC |
| `?mock=running&mockDelay=500` | Delay each IPC call by 500 ms (maximum 5000 ms) |
| `?mock=running&mockRecovery=waiting` | Supervisor recovery state of the managed core (`waiting`, `restarting`, `failed`; payload has attempt, limit and delay). Stop or Start clears it |
| `?mock=running&mockPluginPages=12` | Add 12 extra plugin pages (maximum 30) so the sidebar plugin submenu auto-collapses at normal window sizes |

Plugin pages are native child webviews in the desktop app, which the browser cannot
render. The mock keeps the show, bounds, hide and close state (with the owner token contract) and draws a dashed `[data-mock-plugin-webview]` placeholder over the reported
bounds (hidden while the webview is hidden or closed). It never loads the page; its
`data-mock-url`, `data-mock-reloads` and `data-mock-labels` attributes expose the simulated state for tests.

The selected scenario is remembered locally; an explicit `mock` query overrides it.

## Credential and quota coverage

The running dataset includes more than ten OAuth files, plus a runtime credential
which the authentication-file list excludes. It covers Codex, Claude, Antigravity,
Kimi, xAI and Devin. Examples include long account names and quota labels, multiple
quota windows, a disabled account, an exhausted account with model cooldown,
an expired OAuth token, an empty upstream quota response, unknown remaining quota,
a paid API account and an account with no recent requests.

Quota replies pass through the normal application parsers. Codex and Claude reset
credits are tracked per account: consuming one decreases its balance and refreshes
its usage windows. Credential edits, enable/disable, cooldown reset, deletion,
JSON import/replacement and OAuth cancellation update the same in-memory state.
Malformed imports and missing credentials fail explicitly. Usage event filters
(time, model, provider, source, API key, failure/cancellation) run before pagination.

Unknown IPC commands, management routes and upstream URLs fail explicitly instead
of returning fake success. Add new contracts to `browserMockRuntime.ts`,
`quotaMock.ts` or `pluginMock.ts` when implementing new backend-facing UI.
Other desktop operations may still return preview-only results; the mock does not
launch real apps, write credentials to disk or make upstream API requests.

## Verification

```sh
bun test tests/browserMockRuntime.test.ts tests/browserMockQuota.test.ts
node tests/browser-mock-ui.cjs
```

The browser test uses Playwright (and Microsoft Edge on Windows), opens the real
app, and checks quota rendering, pagination and credential mutations while blocking
external HTTP requests. Its screenshot is saved under `bin-work/`.

## Remote connection fixture

Open Settings → Connection. Select Remote core and enter
management and client origins such as `http://core.example.test:8317` and
`http://client.example.test:8317`. Use `fixture-management-key` for the fictional
management key and a different fictional client key. Origins exclude `/v1` and
`/v8/management`; the application adds protocol paths. Test connection tests the
draft without activating it. Save & connect activates it and saves the mock
target/revision in per-tab session storage before the GUI reloads. A different
management key simulates rejection; an origin containing `offline` simulates an
unreachable core. Correct the values and save to recover, or select Local and save
to restore the prior fixture process state. Reload preserves that connection and local
process snapshot; other fixture mutations reset. **Reset mock data**, switching the
scenario, or disabling mocks clears the saved connection. Separate tabs have independent
mock sessions. Connection values entered here remain in the tab's session storage until
reset or tab close.

The MOCK badge remains visible. No real server is contacted, no process is started
or stopped, and no host credential or client configuration files are written. These
fixtures verify interaction, not native HTTP, TLS or provider OAuth completion.
Run `bun run test:ui:remote-core` with Playwright available for the interaction
regression check; it blocks all external HTTP requests.
