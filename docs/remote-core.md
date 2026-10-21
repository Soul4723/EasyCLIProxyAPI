# Remote core

Remote mode attaches this GUI to an **already-running CLIProxyAPI v8** server.
It does not install or update that server. It can start, stop and restart it
only through [remote host control](#remote-host-control): EasyCLIProxyAPI
running on the core's computer, with remote control allowed there.

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
   The address is an IP literal and port (default `0.0.0.0:8318`, every
   network). Enter a VPN address, for example your Tailscale IP, to listen only
   there. The port must be 1024–65535 and differ from the core's port.
3. Saving generates a **host control key** (`ehc_…`, 256 random bits). Copy it.
   It is separate from the management and client keys and may not equal them.
   **Generate new key** replaces it; the old key stops working at once.

Remote control is off by default. The listener runs only while this app is in
Local mode with remote control allowed and valid settings; otherwise it is
stopped and the panel shows why. Changes to these settings in `config.toml`
are refused while the app runs; use the panel.

### On the other computer (the client)

In **Core connection**, under **Remote host control**, enter the host's URL
(for example `http://100.64.0.1:8318`, an origin only) and the host control
key, or leave both empty. **Test connection** checks the management API and
host control together; nothing is saved until **Save & connect**.

With host control configured and reachable, Home's Start, Stop and Restart and
the plugin page's **Restart core** work as in Local mode, and Runtime Control
shows the host's process ID. When the core is down but the host answers,
status reads **Stopped on remote host**. If the host does not answer, the
buttons stay disabled and Home shows the reason.

Start and Stop on the host behave exactly like pressing them there, including
remembering whether the core should run when that app starts.

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
  at once; one request per connection.
- After 10 failed keys within a minute an address gets HTTP 429, even with the
  right key, until the minute passes.
- Operations reuse the app's own lifecycle functions under its core-operation
  lock, so a remote request and a local button never overlap (HTTP 409).
- The listener speaks plain HTTP, like the management URL caution above: the
  key and status travel unencrypted. Allow it only on a trusted private
  network such as Tailscale, never on the open internet.
- The key is stored in plaintext in `config.toml` on both computers, like the
  other GUI secrets.

### Wire contract (version 1)

Base path `/host-control/v1`, HTTP/1.1, `Connection: close`, JSON replies with
`Cache-Control: no-store`.

| Request | Effect |
| --- | --- |
| `GET /host-control/v1/status` | the host's core status |
| `POST /host-control/v1/core/start` | start the core, wait until its management port answers |
| `POST /host-control/v1/core/stop` | stop the core |
| `POST /host-control/v1/core/restart` | stop if running, then start |

A successful reply is the core status:
`{"protocol":1,"installed":…,"running":…,"ready":…,"starting":…,"managed":…,"processId":…,"currentVersion":…,"message":…}`.
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
- **Advanced Features:** every category shows the remote core's current settings
  (read from its `config.yaml` through the management API), read-only.
- **Management-API pages:** credentials, OAuth (with manual callback submission
  where needed), Vertex import, API providers with model discovery, plugin
  management, and plugin pages served by the remote core.

## Not available remotely yet

These stay visible in place but are disabled, with a short reason:

- Start, Stop and Restart (Home and the plugin page's Restart core) without
  [remote host control](#remote-host-control), or while the host does not answer.
- Start Core on Launch: there is no local core to start. The host's own setting
  follows its last Start or Stop.
- The tray's start, stop and restart: the tray stays a local-core control.
- Agent Configuration, Beginner Mode and Codex tools: machine and agent
  configuration stays local for now.
- Version Management: it installs a local core binary. Updating the remote
  host's core through remote host control is not offered yet.
- Usage, and the Home success rate: reading usage from a remote core would consume
  its usage queue, so no usage is collected in Remote mode.
- Local folder buttons (credentials, logs) and local plugin file installation.
- Editing any core setting: remote configuration is shown read-only.

Silent Launch is hidden and ignored in Remote mode: it keeps a locally hosted core
in the tray, and there is none.

Select **Local core** and choose **Use local core** to return to the existing
local core configuration. Start Core on Launch and Silent Launch keep their
saved values for Local.
Change the active connection through the panel; edits to connection fields in
`config.toml` are only picked up on the next application launch.
