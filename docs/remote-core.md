# Remote core

Remote mode attaches this GUI to an **already-running CLIProxyAPI v8** server.
It does not install, launch, stop, restart, or update that server.

## Connect

1. On the server, enable remote management (`remote-management.allow-remote`)
   and set a management key. Use the equivalent management settings for your
   core version, and ensure the management port is reachable.
2. Stop the GUI-managed local core before switching targets.
3. Open **Settings → Software settings → Core connection**, choose **Remote**,
   and enter the management origin (for example `https://core.example:8317`)
   and its plaintext management key. An origin has no path, query, credentials,
   or fragment.
4. **Test connection** authenticates against `/v8/management/config`, checks
   that the configuration is v8, and reports `X-CPA-VERSION` when supplied.
   Testing does not save. **Save** stores the connection in the GUI's existing
   `config.toml` and reloads the window.

HTTPS validates the server certificate. Redirects are not followed. HTTP is
allowed for trusted networks (for example a private VPN), but sends the
management key and traffic without transport encryption. Do not expose the
management API over an untrusted network. The saved key is plaintext, like
other GUI configuration secrets.

## Available remotely

The runtime card shows authenticated reachability, remote origin and version,
not local installation or process information. Management-API-backed pages
continue to use the selected server, including credentials, OAuth (with manual
callback submission where needed), Vertex import, and plugin management.

## Local-only features

Core lifecycle and installation controls, agent client configuration/launch,
Codex session tools, local usage collection/history, local config-file editors,
local auth/log folders, embedded plugin pages, and probes/model discovery requiring the local client
API are unavailable remotely. These features depend on files, processes or
client credentials on this machine; Remote mode supplies only a management
origin and key. Configure unsupported settings on the server or through its
management interface instead. No remote usage history or agent targeting is
provided. Embedded plugin pages currently depend on the local webview target and
are disabled; plugin management API operations remain available.

Select **Local** and save to return to the existing local core configuration.
Local launch preferences are preserved, but are ignored while Remote is active.
Change the active connection through the panel; edits to connection fields in
`config.toml` are only picked up on the next application launch.
