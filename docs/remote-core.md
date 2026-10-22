# Remote core

Remote mode attaches this GUI to an **already-running CLIProxyAPI v8** server on
another computer. The GUI controls that core: its settings, credentials,
providers and plugins through the management API, and starting, stopping,
restarting and updating it through [remote host control](#remote-host-control)
(EasyCLIProxyAPI running on the core's computer, with remote control allowed
there). Settings that are not about the core, such as this app's preferences,
stay with the computer the GUI runs on.

## Connect

1. On the server, enable remote management (`remote-management.allow-remote`)
   and set a management key. Use the equivalent management settings for your
   core version, and ensure the management port is reachable.
2. Stop the GUI-managed local core before switching targets.
3. Open **Core connection** from the gear button on Home's Runtime Control
   card (the same panel is under **Advanced Features → App preferences**),
   choose **Remote core**, and enter the management URL (for example
   `https://core.example:8317`) and its plaintext management key. The URL is an
   origin only: no path, query, credentials, or fragment.
4. **Test connection** authenticates against `/v8/management/config`, checks
   that the configuration is v8, and reports `X-CPA-VERSION` when supplied.
   Testing does not save. **Save & connect** stores the connection in the GUI's
   existing `config.toml` and reloads the window. Closing the dialog or pressing
   Escape discards unsaved edits.

HTTPS validates the server certificate. Redirects are not followed. HTTP is
allowed for trusted networks (for example a private VPN), but sends the
management key and traffic without transport encryption. Do not expose the
management API over an untrusted network. The saved key is plaintext, like
other GUI configuration secrets.

## Remote host control

CLIProxyAPI's management API has no lifecycle endpoints, and a stopped core
cannot answer a start request. The EasyCLIProxyAPI that already runs and
supervises the core on its own computer can do it instead, if you allow it.

### On the core's computer (the host)

1. Run EasyCLIProxyAPI in **Local** mode; it manages the core as usual.
2. Open **Advanced Features → App preferences → Remote control of this core**,
   turn on **Allow remote control**, check the **Listen address** and save.
   The address is an IP literal and port. Left empty, it is every network on
   the core's port + 100 (`0.0.0.0:8417` for a core on 8317), which keeps it
   apart from the core ports 8317–8319 and from each other. Enter a VPN
   address, for example your Tailscale IP, to listen only there. The port must
   be 1024–65535 and differ from the core's port. When the core's port changes
   (in the app or in the core's configuration), the default listener moves
   with it at once; the app refuses a core port equal to an explicit listen
   port, and if an outside edit makes them equal the listener stops and the
   panel says why.
3. Saving generates a **host control key** (`ehc_…`, 256 random bits). Copy it.
   It is separate from the management and client keys and may not equal them.
   **Generate new key** replaces it; the old key stops working at once.

Remote control is off by default. The listener runs only while this app is in
Local mode with remote control allowed and valid settings; otherwise it is
stopped and the panel shows why. Changes to these settings in `config.toml`
are refused while the app runs; use the panel.

### On the other computer (the client)

In **Core connection**, under **Remote host control**, enter the host's URL
(for example `http://100.64.0.1:8417`, an origin only) and the host control
key, or leave both empty. **Test connection** checks the management API and
host control together; nothing is saved until **Save & connect**.

With host control configured and reachable, Home's Start, Stop and Restart and
the plugin page's **Restart core** work as in Local mode, and Runtime Control
shows the host's process ID. When the core is down but the host answers,
status reads **Stopped on remote host**. If the host does not answer, the
buttons stay disabled and Home shows the reason.

Start, Stop and Restart on the host behave exactly like pressing them there.

Also through reachable host control:

- **Version Management** opens. Checking for the latest core and installing a
  version (or the latest) run on the host, with the host's own download
  source, platform, staged download, rollback and restart of a running core,
  under its core-operation lock. A remote install **requires** the official
  checksum: the host reads `checksums.txt` from the official GitHub release
  (never a mirror) and refuses the install when it is missing or does not
  match the downloaded archive, whichever source served it. (Local installs
  keep their existing behaviour.) Any listed version can be installed,
  including an older one, as in Local Version Management.
  Progress and Cancel work as in Local; the host's own window shows the
  progress too. Progress shown and Cancel apply only to the install this app
  started, on the host it started on, and the connection cannot be changed
  until it finishes. An install already running when the page opens (from the
  host itself or another computer) is followed until it ends. This computer's
  download source, custom mirrors and bundled core do not apply and are
  disabled.
- **Start Core on Launch** (Advanced Features → App preferences) shows and
  changes the host app's own setting at once. This computer's saved value is
  kept for Local mode.
- The **tray** (Linux and Windows) offers Start/Stop and Restart, and reads
  "stopped on host" when the core is down but the host answers.

### Security model

- Off by default; one opt-in listener; its own key, compared in constant time
  (SHA-256 digests).
- Every request needs `Authorization: Bearer <key>` and
  `X-EasyCLI-Host-Control: 1`. Requests carrying browser headers (`Origin`,
  `Referer`, `Cookie`, `Sec-Fetch-*`) are refused before authentication, and
  no CORS headers are ever sent, so web pages cannot drive it (CSRF, DNS
  rebinding).
- Request bodies are refused; the request head is limited to 8 KiB and 32
  headers and must arrive within 10 seconds; at most 8 connections are served
  at once (more are dropped); one request per connection.
- After 10 failed keys within a minute, further failed keys from that address
  get HTTP 429 instead of 401 until the minute passes. The right key is never
  throttled, so a shared address (NAT, VPN exit) cannot lock you out. The
  throttle limits noise; the 256-bit key is what stops guessing.
- Errors that could name local paths (startup logs, install folders) are sent
  as a generic message; the details stay in the host app's log.
- Operations reuse the app's own lifecycle functions under its core-operation
  lock, so a remote request and a local button never overlap (HTTP 409).
- The listener speaks plain HTTP, like the management URL caution above: the
  key and status travel unencrypted. Allow it only on a trusted private
  network such as Tailscale, never on the open internet.
- The key is stored in plaintext in `config.toml` on both computers, like the
  other GUI secrets. On Unix, `config.toml` and the core's `config.yaml` are
  written owner-only (0600) and tightened to 0600 on every save.

### Wire contract (version 1)

Base path `/host-control/v1`, HTTP/1.1, `Connection: close`, JSON replies with
`Cache-Control: no-store`.

| Request | Effect |
| --- | --- |
| `GET /host-control/v1/status` | the host's core status |
| `POST /host-control/v1/core/start` | start the core, wait until its management port answers |
| `POST /host-control/v1/core/stop` | stop the core |
| `POST /host-control/v1/core/restart` | stop if running, then start |
| `GET /host-control/v1/core/latest` | the latest core release for the host: `{"version","assetName"}` |
| `POST /host-control/v1/core/install/latest` | install the latest core, with the official checksum required; replies when done with `{"version","assetName","installDir":"","binaryPath":null}`. An optional `X-EasyCLI-Install-Job: <16–64 letters, digits, dashes>` labels the host's task |
| `POST /host-control/v1/core/install/<version>` | the same for one version (`v`, three numbers, optional `-suffix`) |
| `GET /host-control/v1/core/install` | the host's install task (phase, bytes, percent, result, `job`); messages are public |
| `POST /host-control/v1/core/install/cancel` | cancel the running install if it carries this job (`X-EasyCLI-Install-Job`, required); another job's install gets 409 |
| `POST /host-control/v1/settings/start-core-on-launch/on` (or `/off`) | set the host app's Start Core on Launch; replies with the status |

Usage adds read-only GET routes under the same authenticated listener (no bodies):

| Request | Host-store result |
| --- | --- |
| `GET /host-control/v1/usage/status` | collector state, stored count and store revision |
| `GET /host-control/v1/usage/overview` | totals, costs and chart buckets computed on the host |
| `GET /host-control/v1/usage/analysis` | model, provider, account and masked-key groups |
| `GET /host-control/v1/usage/events` | one bounded request page, including detail and host-computed cost |
| `GET /host-control/v1/usage/pricing` | the host's price catalog and windowed costs |
| `GET /host-control/v1/usage/storage` | the host's database size, record count and size limit; no paths |

All Usage routes accept `q=<URL-encoded JSON UsageQuery>` and optional
`revision=<last revision>`. Query fields are `start`/`end` (RFC3339 instants),
`model`, `provider`, `source`, `upstream`, `api_key_hash`, `failed`, `canceled`,
`page`/`page_size`, and optional numeric `before_id`, `after_id`, `snapshot_id`.
Unknown or duplicate parameters, invalid instants and negative cursors get 400.
`page_size` is clamped to 1–200. Normal pages preserve Local's timestamp order;
ID cursors seek in descending ID order. Use `before_id` to fetch older records,
`after_id` for records inserted since an ID (including late-arriving timestamps),
and `snapshot_id` to exclude later inserts during an export. Event results add
`snapshotId` and `nextCursor`. Cursor clients ignore page totals and continue
until a short/empty page; regular page controls retain the Local totals.

Replies are `{"revision":"…","data":<the Local command's result>}` or
`{"revision":"…","unchanged":true}`. A persisted random store identity plus a
transactional revision (insert/update/delete of events or prices), and a digest
of the host's label settings invalidate cached results. Reads use a read-only
SQLite connection and one snapshot transaction. Status always returns data;
storage is also re-read so a vacuum's disk-size change is not cached. No route
pulls the core's queue, creates a collector, or writes the database.

On both host and client, events/overview have a 2 MiB budget, analysis/pricing
have 512 KiB, and status/storage and other host-control replies retain 64 KiB. An oversized result returns 413:
narrow the time window/filters. Requests retain the existing 8 KiB header limit,
browser refusal, authentication, timeouts and eight-connection concurrency cap.
The client keeps at most 16 target/query-keyed conditional results in memory;
credentials are hashed in cache keys, never sent in query parameters. Automatic
Usage refresh checks the small status/revision every ten seconds while visible,
and skips aggregate/page reads when unchanged (at most sixty seconds, to advance
rolling windows). Filter changes and manual refresh still check the requested
view. There is no full-history transfer on polls.

Raw source values can be credentials or local filenames: source category keys
are hashed; use `upstream` identity for account filtering. Request sources use
masked display labels, API keys are masked, request IDs/executor internals are
omitted, and error bodies are replaced with a privacy note (they may echo
credentials/paths). Known configured secrets and host paths are scrubbed from
all Usage strings. Status exposes only fixed public messages. Remote chart buckets use UTC instants and render in this computer’s timezone,
matching the selected window even when the host is in another timezone.
Older protocol-1 hosts without these routes return 404; the client says to
update EasyCLIProxyAPI on the core's computer. Protocol 1 itself is unchanged.

Status and lifecycle replies are the core status:
`{"protocol":1,"installed":…,"running":…,"ready":…,"starting":…,"managed":…,"processId":…,"currentVersion":…,"message":…,"startCoreOnLaunch":…}`.
`startCoreOnLaunch` is optional; clients accept hosts that do not send it, and
a host without the newer routes answers them with 404.
Errors are `{"error":"…"}` with 400 (malformed request, missing protocol
header, body), 401 (key), 403 (browser request), 404, 405, 409 (another core
operation is running, or the host is not managing a local core), 413, 429,
431 or 500 (the operation failed; the message says why). No local paths are
sent. Clients reject other protocol versions.

## Available remotely

Remote mode keeps the same pages, navigation and cards as Local; only the core
they talk to changes. Values come from the remote core, or show "—" with a
reason; this computer's local data is never shown as the remote core's.

- **Home:** credential, provider-key and model counts come from the remote core.
  Model Health checks the remote core's models through its client API
  (management origin + `/v1`) with the first client key configured on the remote
  core; the management key is never used as a client key. Runtime Control shows
  the remote host, connection status, core version and port. Connect to CPA shows
  the remote client base URL and the remote core's first client key.
- **Usage and Home success rate:** with reachable remote host control, read the
  history recorded by EasyCLIProxyAPI on the core's computer, never this
  computer's history. The same Overview, Request Details (including export),
  Analysis, Price Statistics and Data Management views remain visible. A banner
  identifies the host. Prices and estimated costs belong to the host; price
  editing/synchronization and database maintenance are disabled with a reason,
  and the native handlers refuse those writes. Change them in the host app.
  Export files and view preferences remain on this computer. Without host
  control, Usage stays disabled with setup instructions and Home success rate
  remains unknown. Unreachable/old hosts report their specific error; a failed
  read never falls back to this computer's store.
- **Advanced Features:** every category shows the remote core's current settings
  (read from its `config.yaml` through the management API) and saves changes on
  that core: client keys, proxy, routing, retry, logging and diagnostics, the
  structured settings editor, model aliases and sensitive words. See
  [Editing the remote core's settings](#editing-the-remote-cores-settings).
- **Management-API pages:** credentials, OAuth (with manual callback submission
  where needed), Vertex import, API providers with model discovery, plugin
  management, and plugin pages served by the remote core.
- **Agents, Beginner Mode and Codex sessions:** this computer's agent clients,
  pointed at the remote core. See
  [Agent clients on this computer](#agent-clients-on-this-computer).

## Editing the remote core's settings

A save applies the same change Local mode makes to its own `config.yaml`, to the
remote core's `config.yaml` through the management API:

1. `GET /v8/management/config.yaml`, keeping its `ETag`;
2. the same YAML patch as Local;
3. `PUT /v8/management/config.yaml` with the whole document and
   `If-Match: <ETag>`.

The core checks `If-Match` and writes under one lock (core 8.0.31 and later), so
if anyone else saved in between, the save is refused (HTTP 412) and nothing is
overwritten: "The remote core's configuration was changed elsewhere since it was
read. Nothing was saved; reload and try again." A core without ETags (8.0.29 and
8.0.30) gets a second read just before the write instead; a difference refuses
the save, but a change in the instant between that read and the write cannot be
detected. One save is one request, so it never applies partly. (Model aliases
keep their own management routes, exactly as in Local.) Nothing is sent
if the connection changed after the read. The core reloads its configuration
after a management save; settings marked "Core restart required" apply when the
remote core restarts (Restart works through
[remote host control](#remote-host-control)).

Settings that decide how this app reaches the remote core stay with that core's
computer, because changing them from here would disconnect this app: the listen
address and port, TLS, and the management key (set, generate or disable
management). They are shown disabled with that reason, and the app refuses them
natively in Remote mode, including through the structured editor
(`server/host`, `server/port`, `server/tls/*`, `management/*`). Change them on
the core's computer, then update **Core connection**.

Also different from Local:

- **Proxy:** this computer's system proxy does not apply to a remote core. The
  proxy URL is written as entered; empty means a direct connection.
- **Client key remarks** are notes this app keeps for its local core's keys; remote
  keys have none, so the remark field is disabled.
- **Folder pickers** (for example the credentials folder) are disabled: folders
  are on the core's computer, so type the path.

## Agent clients on this computer

Agent configuration is about the computer the GUI runs on, so **Agents**,
**Beginner Mode** and the Codex session tools work in Remote mode as in Local:
they configure, back up, launch and manage the agent clients installed on this
computer. In Remote mode the clients are pointed at the remote core's client API:
the management origin (the core serves `/v1` on the same origin) and the remote
core's first client API key. The management key and this computer's local core
key are never used as a client key; if the remote core has no client key, the
action fails with that reason instead of falling back to Local. Model lists for
agents and model aliases come from the remote core. Switching modes and applying
a client again points it at the selected core. Restoring a backup whose managed
credentials belong to the other target is refused; configure the client again
instead.

## Not available remotely

These stay visible in place but are disabled, with the reason:

- Start, Stop and Restart (Home, the plugin page's Restart core, the structured
  editor's Restart now and the tray), Version Management and Start Core on Launch
  without [remote host control](#remote-host-control), or while the host does not
  answer.
- Installing the bundled core, and this computer's download source and mirrors,
  while Remote: they belong to this computer.
- Usage and Home success rate without remote host control; reading the core's
  draining queue is never a fallback. The non-draining management API's per-key
  aggregates cannot supply the host's request details, history, charts or prices.
- Usage price edits, price sync, database repair, size-limit changes and shrink:
  these belong to EasyCLIProxyAPI on the core's computer.
- Opening local folders (credentials, logs) and installing a plugin from a file on
  this computer: they are on, or would have to be copied to, the core's computer.
  Store plugins install through the management API as in Local.
- The remote core's listen address, port, TLS and management key (see above).

Silent Launch is hidden and ignored in Remote mode: it keeps a locally hosted core
in the tray, and there is none.

Select **Local core** and choose **Use local core** to return to the existing
local core configuration. This computer's Start Core on Launch and Silent Launch
keep their saved values for Local.
Change the active connection through the panel; edits to connection fields in
`config.toml` are only picked up on the next application launch.
