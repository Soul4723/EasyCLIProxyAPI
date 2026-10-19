# Connect to a remote core

EasyCLIProxyAPI can manage one already-running CLIProxyAPI v8 core while retaining
its local core settings. This does not provide SSH access or remote process control.

This page has two parts: a user guide (how to connect and what to expect) and a
[contract reference](#contract-reference) (settings schema, commands, fencing, transport,
lifecycle, usage and limitations) for contributors and for reconciling with other
remote-mode designs.

## Connection

1. Open **Settings → Connection**.
2. Under **Core location**, select **Remote core**. Enter the management origin and the
   plaintext management key.
3. Enter the client API origin and client API key separately (**Same as management**
   copies the management origin). Origins include the scheme and port, for example
   `http://core.example.test:8317`, but no `/v1` or `/v8/management` suffix. A blank client
   key is allowed for a core without client authentication.
4. **Test connection** authenticates a read of the candidate core's v8 configuration
   and reports its version. Testing does not save or switch the active connection,
   and does not verify client authentication, inference, or provider availability.
5. **Save & connect** selects and persists the target, even when it is unavailable, and
   then reloads the app window onto the new target. Saving without changing the active
   target is a no-op: the window is not reloaded. Correct the settings and test/save again
   to recover, or select **This computer** and **Save & use this computer** to return.

While the draft is invalid, the save bar says why **Save & connect** is disabled (for
example "Enter a valid client API origin"). Field errors also appear after **Test
connection**.

The server must allow remote management and have a management key configured.
Management and client API keys are different credentials, even when both origins
refer to the same listener.

**HTTP sends keys in clear.** Plain `http://` to a host that is not this computer
(`localhost`, `127.0.0.0/8` and `::1` count as this computer) sends the management key and the
client key unencrypted. Settings → Connection shows a caution for such origins. Prefer
`https://`, or use plain HTTP only on a network you trust (a Tailscale or other private tunnel
encrypts the path itself). HTTPS validates the remote certificate: it must be trusted and valid
for the host name, and self-signed remote certificates are rejected. GUI-to-core
connections are direct and do not use the core's upstream/provider proxy.

Credentials follow the app's existing plaintext `config.toml` persistence convention; this
change does not introduce an OS keychain. On Linux and macOS the app creates the file
with mode 0600 and tightens an existing file to 0600 on its next save. On Windows the file
inherits the per-user ACL of the profile directory where the app keeps its configuration;
the app does not set an explicit ACL. Do not publish or share that file or its backups.

If this app started a local core that is still running, saving Remote is refused and the
page explains it. Stop that core on **Overview** first, then save again; your draft
stays while you remain in Settings. No local core is stopped implicitly. This safeguard
reflects the app-owned process lifetime, not remote host supervision. Externally managed
local processes are not stopped when exiting in Remote mode. The last saved remote target
is retained when selecting Local.

Privacy mode (the eye button in the page header) is a global display setting. It masks the
remote host shown in the active-connection summary like any other identifier.

## Portable settings for another machine

Use **Export settings** (Settings → Connection → Portable settings) after saving a Remote
connection, then **Import settings** on the other machine. Exports contain only the remote
management and client API origins; local client files, executable paths, backups and
unrelated settings stay on this machine. Keys are excluded by default. Turn on **Include
keys** only when you can handle the exported file as a secret.

Import loads an unsaved draft, without changing the active connection. Review both origins
on each machine (localhost refers to that machine), enter missing keys, and save to apply
the usual validation and local-process safeguards. The client origin is required; a blank
client key remains allowed. Invalid files leave the draft and saved configuration unchanged.
Save edits before exporting (export is disabled while the draft differs from the saved
connection, and outside Remote mode). Importing does not modify client files. After saving,
use **Agents** on each machine to configure its installed clients against the selected remote
core.

The version-1 JSON format is described in the [contract reference](#portable-format-v1).
Native file dialogs and cross-platform transfer require platform validation.

## Runtime and management

Remote status means authenticated reachability, not local process ownership. The sidebar
footer and **Settings → Connection** show the management host and the reported core version,
without local installation or PID claims. Local start/stop/restart and core
installation/update actions are unavailable while attached remotely, including tray and
restart prompts. Perform remote restarts and upgrades on the core's host using its existing
supervision.

Management requests, credentials, provider settings, plugins and configuration editors use
the selected management target. Core-host paths (certificates, auth folders and plugin
directories) belong to that host; opening local credential/log folders is disabled remotely.
Changing listener/TLS settings may make the core unreachable after its next restart; update
the saved origins accordingly.

Configuration edits use fresh remote reads and targeted field/subtree writes. CLIProxyAPI
**8.0.29 does not implement ETag/If-Match configuration preconditions**. A fresh-value check
detects observed conflicts but is not atomic: concurrent same-field edits can race, and
multi-request edits can partially apply. A failed save reports this and requires a reload.
Uncertain writes are not blindly retried or rolled back over another editor's changes.

## Local agent clients

While Remote is selected, **Agents** can configure and launch supported agent clients on this
computer against the saved remote client API origin and client API key. Configure a client for
the selected remote target before launching or restarting it. Client configuration files and
client processes remain local; this does not configure clients on the remote host or provide
SSH machine configuration.

A blank remote client key stays blank: it does not fall back to a local API key or the
management key. The management key is never used for client traffic. Core lifecycle actions
remain local-only and are unavailable while Remote is selected.

## OAuth

OAuth authorization starts and polls on the selected core. Device flows can be completed in a
browser on another machine while the core polls the provider. Authorization-code flows
require the complete final callback URL to be submitted through the callback input when
automatic redirection cannot reach the core. A provider redirect to `localhost` on this
computer does **not** reach a listener on the remote core host. Keep callback URLs private:
they contain sensitive one-time authorization data. After submission, wait for the same
core's terminal OAuth status; callback acceptance alone is not login completion. Switching
targets invalidates pending sessions in this app; start authorization again. Cancel, Close, or Escape in the sign-in dialog stops polling and
cancels the pending session on the core, for built-in and plugin flows alike. Unmounting the
sign-in view also cancels any pending sessions.

Provider behavior follows the core's supported flows; no automatic cross-machine callback
capture or successful live provider authorization is implied by a successful connection
test. Plugin OAuth (Plugins → a plugin with a sign-in) follows the same rules and additionally
depends on its plugin.

## Usage compatibility mode

Remote collection uses the authenticated HTTP usage queue, never a local RESP subscription.
Local and remote histories are stored separately; remote history is scoped by management
origin, so a key rotation retains that origin's history. Changing the server behind an
unchanged origin cannot be detected automatically.

While the selected core is not ready, the collector re-checks readiness with backoff: it
starts at 2 seconds, doubles after each not-ready result, and is capped at 28 seconds. Becoming
ready, a target or lifecycle reset, or a core status emission restarts the backoff at 2 seconds
and forces an immediate check.

The queue removes records when read and is not a durable replay log. Use one queue consumer:
another app or collector can consume events first, and the core's live subscriber behavior
can prevent HTTP backfill. Lost events cannot be promised back. After an uncertain dequeue
result, remote collection pauses instead of retrying the pop automatically. Inspect the
visible collector message (Usage → Data) before explicitly resuming. After a successful pop,
the batch is first written to the local usage inbox; if processing it then fails, the batch is
retained and only processing is retried (the raw records are not written again, so a retry
cannot double-count). Retained batches retry against their captured origin and store before
any further collection, even after a target switch, so a blocked original store blocks
collection for other targets too. A crash, collector stop, or shutdown before the inbox write
can still lose the in-memory batch; this is not an exactly-once delivery guarantee.

## Invalid saved connection settings

If the saved `config.toml` (or legacy `cpa-gui.yaml`) in the app's configuration directory
cannot be read or parsed, or its Remote origin or management key is invalid, startup stops.
The app shows a native error dialog ("EasyCLIProxyAPI cannot start") with the problem and
repair instruction, and also prints it to stderr. It does not replace the target with Local,
overwrite the saved file, install/adopt/start a local core, or open a repair screen. Correct
the saved file (or remove it to start with first-run Local defaults) and relaunch. Only an
absent configuration uses first-run Local defaults. The dialog is the only on-screen
indication, because the app has no window yet.

Local HTTPS management retains self-signed certificate compatibility when Local core TLS is
enabled. Remote HTTPS requires a trusted, hostname-valid certificate; both management clients
bypass proxies and refuse redirects.

## Verification boundary

The feature's tests use isolated files, fake keys and HTTP fixtures. An isolated
CLIProxyAPI 8.0.29 also verified native connection testing and remote settings reads across
two machines. These checks do not establish live provider OAuth success, inference quality,
quota availability, or every deployment's certificate/proxy setup. The UI has been exercised
against the browser mock and unit/UI tests, not end to end in every packaged platform build.

Upstream contract: [v8 management API at the bundled 8.0.29 source](https://github.com/router-for-me/CLIProxyAPI/blob/5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3/docs/management-api-v8.md).

---

# Contract reference

This section states what the implementation guarantees, so that another remote-mode design
(for example the multiple-profile remote mode discussed upstream in #329 and #395) can be
reconciled against it. It describes behavior, not a roadmap.

## Settings schema

Stored in the GUI `config.toml` (kebab-case keys):

| Key | Type | Notes |
| --- | --- | --- |
| `connection-mode` | `"local"` \| `"remote"` | Defaults to `local`. |
| `remote-management-origin` | string | Normalized origin (see below). |
| `remote-management-key` | string | Plaintext, never hashed. Required in Remote mode. |
| `remote-client-origin` | string | Normalized origin. Required in Remote mode. |
| `remote-client-key` | string | At most 4096 bytes, no control characters. May be blank. |

- **Origin rules:** `http` or `https` scheme, a host, no userinfo, path, query or fragment.
  Surrounding whitespace and a trailing `/` are removed.
- **Management key:** trimmed, must pass the local management-key validation, and must not be
  a hashed value (a plaintext key is required).
- **Local values are retained while in Remote.** Selecting Remote changes only
  `connection-mode` and the `remote-*` keys; saving Local keeps the last remote values.
- **`target_revision`** is in memory only (`#[serde(skip)]`). It starts at 0 on each launch,
  increases by one (wrapping) on every target change, and is never persisted. It identifies a
  target change within one process lifetime, not a configuration version.
- **File permissions:** created 0600 on Unix, existing files tightened to 0600 on save. No
  explicit ACL on Windows. Saves replace the file atomically (temporary file, fsync, rename).

## Portable format v1

`easycli-proxy-connection`, a JSON document with a remote `connection`:

- Fields: `managementOrigin`, `clientOrigin`, optional `managementKey` and `clientKey`.
  Keys are written only when the user chose to include them; absent keys import as blank.
- Remote only: a document whose mode is not remote is rejected.
- Size cap 1 MiB on import and export.
- Export replaces the file atomically through a temporary file created with mode 0600 on Unix.
- Import validates like a save and returns a **draft**; it never changes the active connection
  or any client file.

## Commands and events

| Command | Behavior |
| --- | --- |
| `get_core_connection` | Returns the saved connection (Local values retained). |
| `save_core_connection` | Validates (Remote), persists the target, bumps the revision, emits `core-connection-changed`. A save that leaves the target unchanged does not bump the revision. |
| `test_core_connection` | Remote drafts only. Never saves or switches. Result classes: connected (with version), unreachable (network and TLS failures are not distinguished), key rejected (401), forbidden (403), not a v8 management API (404 or no `config-version: 8`), other HTTP status. |
| `export_core_connection(path, includeSecrets)` | Remote only. |
| `import_core_connection(path)` | Returns a draft. |
| `get_management_target_revision` | The only way a document learns its revision. |
| `resume_usage_collection(expectedOrigin, expectedRevision)` | Resumes a paused remote collector for that origin and revision. |
| `lighting_*` | `lighting_list`, `lighting_get`, `lighting_save`, `lighting_delete`, `lighting_set_enabled`, `lighting_run_now`, `lighting_report_reset`, `lighting_history`, `lighting_capabilities`, `lighting_status`. |

Event `core-connection-changed { revision }` is emitted after a target change, including
changes made outside this window.

## Fencing and revision semantics

- One WebView document owns one revision. It reads the revision once through
  `get_management_target_revision` and never refreshes it for later requests.
- A save blocks the document (every later fenced call fails with "The core connection
  changed; reload before continuing") and then reloads it onto the new revision. A failed save
  restores the document. A save that leaves the target unchanged is a no-op: the revision does
  not change and the document is restored, not reloaded. The same reload happens on
  `core-connection-changed` from outside. A blocked document that is about to reload is not
  subject to the unsaved-changes "Leave site?" prompt.
- Every fenced native command takes the document revision and re-checks it under the
  `target_operation` lock; a mismatch fails before any request is sent. Responses that arrive
  after a target change are discarded.
- OAuth `state` is bound to the revision that started it. It stays invalid after a switch,
  even when switching back to identical settings.
- Lock order is `target_operation`, then `CORE_OPERATION_LOCK`. Long provider calls must not
  hold `target_operation` (lighting runs its provider request unlocked and discards its
  result if the target changed meanwhile). `management_request` follows the same rule for
  reads: `GET` requests and the `POST /requests/api-call` provider proxy hold the lock only to
  validate the revision and build the request, send unlocked, and re-check the revision before
  returning (a moved target fails with "Core connection changed; discard the previous target
  response"). `get_oauth_status` does the same. Writes (`PUT`/`PATCH`/`DELETE` and other
  `POST`s) and uploads keep the lock across the request, so a connection switch waits for them
  and they reach the core in submission order.
- The frontend routes fenced calls through `services/documentTarget`, which binds
  `expectedRevision`. `tests/unit/platform/platformBoundary.test.ts` fails when any `src/` code calls a
  fenced command through an unfenced `invoke`, and checks the browser mock's list of fenced
  commands against the Rust signatures.

**Fenced commands.** `management_request` carries the revision inside its request. These 42
commands take `expectedRevision` as a top-level argument:

`add_core_api_key`, `clear_core_management_secret_key`, `create_speed_alias`,
`create_thinking_alias`, `delete_core_api_key`, `delete_speed_alias`, `delete_thinking_alias`,
`get_core_config_settings`, `get_core_sensitive_words_settings`, `get_core_tls_settings`,
`get_extended_core_config`, `get_model_alias_edit_source`, `get_model_alias_sources`,
`get_oauth_status`, `get_speed_alias_sources`, `get_speed_aliases`,
`get_thinking_alias_sources`, `get_thinking_aliases`, `import_vertex_credential`,
`lighting_report_reset`, `lighting_save`, `resume_usage_collection`,
`save_core_logging_settings`, `save_core_sensitive_words_settings`, `save_core_tls_settings`,
`save_extended_core_config`, `save_gui_settings`, `save_network_endpoint_settings`,
`save_network_routing_settings`, `save_retry_settings`, `save_session_routing_settings`,
`set_core_management_secret_key`, `set_core_plugins_enabled`, `set_core_proxy_url`,
`set_core_request_log`, `set_core_routing_strategy`, `set_core_session_affinity`,
`set_core_session_affinity_ttl`, `start_oauth_login`, `submit_oauth_callback`,
`update_core_api_key`, `upload_auth_file`.

## Transport policy

- **Remote management and client traffic:** strict TLS (trusted, hostname-valid certificate),
  redirects refused, system and environment proxies bypassed (`no_proxy`), 10 s connect and
  30 s request timeouts. Test connection uses 5 s connect and 10 s request timeouts.
- **Local management:** a self-signed certificate is accepted only while Local core TLS is
  enabled. Redirects are refused and proxies bypassed as for Remote.
- Management and client keys are separate credentials and are never substituted for each
  other.
- Plain HTTP is allowed to any host; the UI warns when the host is not loopback.

## Lifecycle and supervision

- Switching to Remote is refused while the app-owned local child process is running. A
  successful switch disarms supervision and clears adopted processes.
- Remote mode supervises nothing. Lifecycle actions (start, stop, restart, install, update)
  are disabled.
- The crash supervisor is the single restart executor for the app-owned local core: at most 5
  attempts with 1, 2, 5, 10 and 30 s delays; 60 s of stable uptime resets the count. It runs
  only in Local mode. `core_recovery` is status-only.

## Usage queue semantics

- Remote collection reads the core's HTTP usage queue (destructive, single consumer). Local
  uses its own source. Histories are stored per origin.
- An uncertain pop pauses collection for that origin and revision until the user resumes it.
- A popped batch is committed to the local inbox before processing. A processing failure
  retains the batch and retries processing only; raw rows are never written twice.
- A crash before the inbox write loses the in-memory batch (no exactly-once guarantee).

## Remote configuration writes

- Writes are field-path `PUT`/`DELETE` requests on `/v8/management/config/<path>`.
- Before each change the current value is re-read and compared with the value the editor
  started from; a difference fails with "Remote configuration changed; reload before saving".
- There is no rollback and no retry of uncertain writes. A partial apply reports
  "Remote configuration save stopped after N of M confirmed changes; some changes may have
  applied. Reload before editing."

## Compatibility

Minimum core: CLIProxyAPI 8.0.29 (v8 management API under `/v8/management`, response
`config-version: 8`). The core version is read from the `X-CPA-VERSION` response header (or
`X-CLIProxyAPI-Version`). Cores without ETag/If-Match are the supported case.

## Known limitations

- Remote mode supervises nothing on the remote host.
- Remote configuration writes are field-by-field and not atomic (see above).
- The usage queue is destructive with a single consumer and not exactly-once.
- Cross-machine authorization-code OAuth needs a manual callback paste; device flows work. A
  live provider login is not proven.
- Test connection reports TLS and network failures as one class.
- Credentials are plaintext in `config.toml` (no keychain); on Windows the file relies on the
  profile directory's ACL.
- One saved remote target only (no profiles). No custom CA or proxy for the connection to the
  core.
- Lighting schedules run only while the app runs and only for Codex and Claude. Schedules are
  keyed by a hash of the target's endpoint and management key, so rotating the management key
  leaves the old schedules stored but inactive.
- A Remote target with a blank client key can never restore a managed agent backup (its
  credentials cannot match); the message says the credentials do not match.
