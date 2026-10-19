# Observe the real debug GUI (Linux)

This harness runs Tauri/WebKitGTK with the production frontend **embedded in a debug
binary**, not Vite or the browser mock. It requires Bun, Rust/Tauri build prerequisites,
Node, ImageMagick `identify`, `mkfifo`, `qdbus6`, a running KDE graphical session and `spectacle` with active-window
capture support. No driver, input injection or elevated permissions are needed.

```bash
bun install --frozen-lockfile
node scripts/dev-observe.mjs \
  --core /absolute/path/to/test-core/cli-proxy-api \
  --core-config /absolute/path/to/test-core/config.example.yaml \
  --name local-before --actions
```

The core binary and its **unmodified distribution template** must be supplied; do
not supply a real configured core directory. The harness copies only these two
files. It builds with `bun run tauri build --debug --no-bundle` and
`CARGO_TARGET_DIR=$HOME/.cache/easycli-cohesive-target`. Use `--no-build` to reuse
that binary, or `--binary /absolute/path` to select another embedded debug binary.
The debug build deliberately uses a production frontend: `import.meta.env.DEV`
is false (so the kit gallery is absent).

Each invocation needs a fresh `--name`: existing sandboxes are rejected. The GUI,
core, auth files, config and HOME/XDG paths live below
`~/.cache/proxy-work/sandbox/<name>`. A free loopback port is chosen and the GUI
starts its own core through `window.__TAURI_INTERNALS__.invoke('start_core_process')`.
Custom client-root environment overrides (such as `CODEX_HOME`) are removed so
they cannot escape the sandbox HOME/XDG directories. No provider credentials are seeded, so empty
provider, quota, request and session lists are expected. The driver stops the
GUI/core process group on success or failure; SIGINT/SIGTERM requests stop after
the current measurement. Do not SIGKILL the driver.

By default every main page, Providers and Agents tabs, Usage tabs, Settings tabs,
and guided setup are measured. Override with e.g.
`--routes /overview,/usage/requests,/settings/logs`. Each page gets 10 seconds to
settle, then a 60-second idle window (`--settle` and `--seconds` override these).
`--actions` also exercises stop/start/restart, clicks the privacy toggle twice,
and opens Settings → Logs. Lifecycle actions use the same application IPC commands
as the UI; the privacy toggle uses the real React control.

Outputs default to `~/.cache/proxy-work/measure/<name>` (`--out` overrides):

- `ipc.log`: complete command trace, with `REPORT BEGIN/END` idle boundaries.
- One `.log` and active-window `.png` per page; `action-*.log` for action bursts.
- `summary.md` / `summary.json`: calls/min, per-command counts, DOM mutation records.
- `run.json`: base commit, routes, durations, port and sandbox; `app.log` / stdout
  provide startup diagnostics. Redirect stdout to an external driver log if desired.

Counts exclude reports and include management method/path distinctions. Idle
windows exclude navigation and settling; rates normalize when `--seconds != 60`.
The host clock defines the idle window even if the document reloads. Observer
counts are sampled each second and summed across documents; on reload they are
**lower bounds** (the final unsampled changes can be lost). `documents` records
how many distinct document time origins were sampled. A temporary KWin script
activates only the sandbox GUI PID immediately before capture and is immediately unloaded
([KWin scripting API](https://develop.kde.org/docs/plasma/kwin/api/)).

The driver retries captures whose image dimensions do not match the webview plus
window decorations. This catches many wrong-window captures, but is not a substitute
for visually verifying the title/content (another similarly sized window can pass).

DOM mutation **records** are a flicker proxy, not a rendered-frame measurement:
clocks, live status and hidden DOM can mutate without visible flicker, and CSS
animations need not mutate DOM. Inspect every screenshot and verify core readiness
(`REPORT CORE`); a screenshot is a still frame, not proof of no flicker.

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
  before evaluation for reliable active-window screenshots. Create the FIFO
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
