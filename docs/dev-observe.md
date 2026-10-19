# Observe the real debug app

This harness measures the real Tauri/WebKitGTK app with a production frontend embedded
in a **debug binary**, not Vite or the browser mock. It runs on a private Xvfb display
with isolated HOME/XDG directories and a new session bus. The previous KDE/KWin/
Spectacle path has been removed; no desktop session is required.

**Never run it on your daily desktop session. Use a disposable Linux test host or VM.**
Use test-only cores, keys and data. Remote collection consumes the core's usage queue;
never point this harness at a core serving real sessions.

## Prerequisites and build

On the disposable Linux host install `xvfb`, `x11-apps` (for `xwd`), `imagemagick`
(`convert` and `identify`), `xdotool`, `nodejs` (Node 22+), and `dbus-daemon`
(`dbus-run-session`). Install `fuse3` (`fusermount3`) to clean up private portal/GVfs
mounts if the desktop libraries activate those services. `strace` is optional. The driver owns an unused display
(1280×800, software rendering); `--display :105` optionally selects an **unused**
nonzero display. It refuses occupied displays and never attaches to a desktop.
`xdotool` is useful for manual investigation, but idle sampling needs no input driver.

Build on Linux with Bun and the Rust/Tauri Linux build prerequisites installed:

```bash
bun install --frozen-lockfile
bun run check
CARGO_TARGET_DIR=$HOME/.cache/easycli-target bun run tauri build --debug --no-bundle
```

The binary is `$HOME/.cache/easycli-target/debug/cpa-gui`. This does not launch it.
Debug assertions/hooks remain enabled while `import.meta.env.DEV` is false (no kit
gallery). If building on another Linux machine, copy this binary and the repo's
`scripts/dev-observe.mjs` plus `scripts/dev-observe/` to the test host, preserving
their relative layout. Use a compatible architecture and GTK/WebKit runtime.
You can strip debug symbols from a **copy** for transfer; this does not disable hooks.
Pass `--revision "$(git rev-parse HEAD)"` when running a copied tree without Git.
`run.json` also records the binary SHA-256 so evidence can be tied to the exact build.

Supply a CLIProxyAPI test binary and its **unmodified distribution**
`config.example.yaml` for Local mode, not a configured core directory. Only those
two files are copied. For Remote, start a separate test core with test-only keys,
no provider credentials and a private auth directory. It must be **core ≥ 8.0.29**
with the v8 management API (`config-version: 8`); allow remote management when
connecting across hosts. See [Remote core connections](remote-core.md) for the
configuration, transport policy and destructive single-consumer queue semantics.
The harness does not provision, stop or modify the externally managed Remote core.

## Local pass

Run these commands **on the disposable host**, from the app repo (or copied scripts):

```bash
node scripts/dev-observe.mjs --no-build \
  --binary /absolute/path/to/cpa-gui \
  --core /absolute/path/to/test-core/cli-proxy-api \
  --core-config /absolute/path/to/test-core/config.example.yaml \
  --mode local --name local-pass
```

Without `--no-build` the driver builds first, using the Cargo target directory above
(or `$CARGO_TARGET_DIR`). The app starts its own copied core on a free loopback port.
No provider credentials are seeded, so empty lists are expected. `--actions` optionally
checks Local stop/start/restart and the privacy toggle before idle measurements.

## Remote pass

Set the management origin and client origin explicitly. The host is supplied through
these CLI origins, never hardcoded. Key values come only from environment variables
or files; there are no key-value CLI arguments. Files override the corresponding env
variables. Client and management keys are separate; a blank client key stays blank.

```bash
export TEST_MANAGEMENT_ORIGIN=http://127.0.0.1:8317
export TEST_CLIENT_ORIGIN=http://127.0.0.1:8317
node scripts/dev-observe.mjs --no-build \
  --binary /absolute/path/to/cpa-gui \
  --mode remote --name remote-pass \
  --management-origin "$TEST_MANAGEMENT_ORIGIN" \
  --client-origin "$TEST_CLIENT_ORIGIN" \
  --management-key-file /absolute/path/to/test-management.key \
  --client-key-file /absolute/path/to/test-client.key --strace
```

Alternatively set `EASYCLI_OBSERVE_MANAGEMENT_KEY` and
`EASYCLI_OBSERVE_CLIENT_KEY`. No Local core or template is needed for Remote.
The driver pre-seeds the isolated app config; this is an idle pass, not a test of
the Connection form or mode-switch UI. It verifies authenticated core readiness
before sampling. Stop the externally managed test core yourself after the pass.

## Routes, timing and output

Default: all 22 routes (main pages, Providers/Agents/Usage/Settings subpages and guided
setup), **10 seconds settle + 60 seconds idle per route**. To select a shorter pass,
append `--routes /overview,/usage/requests,/settings/routing`. `--settle` and
`--seconds` override the windows; rates are normalized per minute. Remote guided
setup intentionally redirects to Overview, and the report records the actual route.

Output defaults to `$XDG_CACHE_HOME/easycli-observe/measure/<name>` (or
`~/.cache/easycli-observe/measure/<name>`). `--out /absolute/output/directory`
overrides it. Choose a fresh name/output directory for each run; reuse is refused.
The sandbox remains under the same cache root's `easycli-observe/sandbox/<name>`.
All directories/files are private to the current user. The sandbox contains test
keys in plaintext app settings: do not commit it or publish raw captures. Inspect
and redact evidence before sharing, especially Settings Access screenshots.

- `summary.json` / `summary.md`: per-route IPC calls/min, command counts, DOM mutation
  records/min, document count, actual routes and baseline/regression flags.
- `ipc.log`: complete sanitized command trace plus `REPORT BEGIN/END` idle boundaries;
  one route `.log` contains the corresponding window, excluding navigation/settling.
- One `.xwd` and `.png` per route: root capture of the harness-owned virtual display.
- `run.json`: revision, binary checksum, mode, routes, timing and sandbox metadata.
  `app.log` / `xvfb.log` contain startup diagnostics.
- With `--strace`: `connect.trace` and `connect.json` contain timestamped native
  `connect` syscalls. These include all destinations, not just the core. Filter by
  core address/port and thread before calculating retry intervals. Native collector
  HTTP is **not** counted as frontend IPC. No outage or core restart is injected.

Re-run analysis/report generation without launching an app:

```bash
node scripts/dev-observe/report.mjs /absolute/output/directory
```

Reference healthy empty-core measurements from 2026-10-19: **Local 2–6 IPC calls/min
per page; Remote 4–8; Settings DOM mutations 0**. Usage pages are at the upper end.
These are comparison baselines, not universal performance budgets; inspect command
counts and route content before diagnosing a regression. A below-baseline result
can mean the app was not ready. Reports flag above-range IPC, Settings mutations,
reloads and redirects; flags do not automatically fail the run.

Inspect every screenshot and `REPORT CORE` readiness. A screenshot is a still frame,
not proof of no flicker. DOM mutation **records** are a proxy, not rendered frames:
clocks/hidden DOM may mutate, while CSS animation may not. Host-clock idle windows
survive reloads; observers sampled each second are summed across document time origins.
On reload the final unsampled changes can be lost, so counts are lower bounds.

The driver removes client-root overrides so agents cannot escape the sandbox HOME/XDG.
On success/failure/SIGINT/SIGTERM it stops the GUI/core/WebKit process group, private
bus and Xvfb. Interrupts are handled after the current sampling step; do not SIGKILL
the driver. Sandboxes and evidence are retained for inspection; remove them when no
longer needed. Remote cores remain the operator's responsibility.

## Debug-only hooks

All Rust instrumentation lives behind `cfg(debug_assertions)`; release binaries
contain neither hooks nor pseudo-command. Each facility is opt-in:

- `CPA_GUI_IPC_TRACE=<file>` appends Unix milliseconds and app command name.
  Only `management_request` additionally records a whitelisted HTTP method and
  relative path, without query/fragment. No arguments, bodies, keys or headers
  are serialized. Invalid paths/methods get placeholders.
- While a trace file is successfully open, `dev_report` resolves and appends
  `REPORT <text>` (newlines/control characters become spaces). Reports are
  explicitly supplied diagnostic text: **do not put secrets in them**.
- `CPA_GUI_DEV_CONTROL=<existing-fifo>` enables a background FIFO reader on Unix.
  Each line is evaluated as JavaScript in the main webview, which is focused
  before evaluation inside the private display. Create the FIFO
  with mode 0600. Example:

  ```bash
  printf '%s\n' "location.hash='/usage';" > /path/to/control.fifo
  printf '%s\n' "window.__TAURI_INTERNALS__.invoke('dev_report',{text:'hello'});" > /path/to/control.fifo
  ```

- `CPA_GUI_START_ROUTE=/usage` sets the hash on the first completed main-page
  load; normal hash-router navigation then applies.

The current `build.rs` does not generate an application ACL manifest. Tauri 2
therefore permits local custom application commands without individual capability
entries; existing capabilities restrict plugin/core commands separately.
`dev_report` is handled only inside the trace-enabled debug wrapper, not registered
as a release command. If an app ACL manifest is introduced, add a debug-only
permission for it. The harness's `READY` report checks this path end to end.
