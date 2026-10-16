# Connect to a remote core

EasyCLIProxyAPI can manage one already-running CLIProxyAPI v8 core while retaining
its local core settings. This does not provide SSH access or remote process control.

## Connection

1. On Home, open the settings button next to Runtime Control's refresh button.
2. Select **Remote**. Enter the management origin and plaintext management key.
3. Enter the client API origin and client API key separately. Origins include the
   scheme and port, for example `http://core.example.test:8317`, but no `/v1` or
   `/v8/management` suffix. A blank client key is allowed for a core without client authentication.
4. **Test connection** authenticates a read of the candidate core's v8 configuration
   and reports its version. Testing does not save or switch the active connection,
   and does not verify client authentication, inference, or provider availability.
5. **Save connection** selects and persists the target, even when it is unavailable.
   Correct the settings and test/save again to recover, or select Local to return.

The server must allow remote management and have a management key configured.
Management and client API keys are different credentials, even when both origins
refer to the same listener. HTTP is allowed; HTTPS validates the remote certificate.
GUI-to-core connections are direct and do not use the core's upstream/provider proxy.
Credentials follow the app's existing plaintext `config.toml` persistence convention;
this change does not introduce an OS keychain. Do not publish that file.

If this GUI started a local core that is still running, saving Remote is refused.
Close settings, explicitly stop that core in Runtime Control, then reopen settings;
the draft is retained while you remain on Home. No local core is stopped implicitly.
This safeguard reflects the GUI-owned process lifetime, not remote host supervision.
Externally managed local processes are not stopped when exiting in Remote mode.
The last saved remote target is retained when selecting Local.

## Runtime and management

Remote status means authenticated reachability, not local process ownership. It
shows the management origin and reported core version, without local installation
or PID claims. Local start/stop/restart and core installation/update actions are
unavailable while attached remotely, including tray and restart prompts. Perform
remote restarts and upgrades on the core's host using its existing supervision.

Management requests, credentials, provider settings, plugins and configuration
editors use the selected management target. Core-host paths (certificates, auth
folders and plugin directories) belong to that host; opening local credential/log
folders is disabled remotely. Changing listener/TLS settings may make the core
unreachable after its next restart; update the saved origins accordingly.

Configuration edits use fresh remote reads and targeted field/subtree writes.
CLIProxyAPI **8.0.29 does not implement ETag/If-Match configuration preconditions**.
A fresh-value check detects observed conflicts but is not atomic: concurrent
same-field edits can race, and multi-request edits can partially apply. A failed
save reports this and requires a reload. Uncertain writes are not blindly retried
or rolled back over another editor's changes.

## Local agent clients

While Remote is selected, the Agents page can configure and launch supported agent
clients on the GUI machine against the saved remote client API origin and client
API key. Configure a client for the selected remote target before launching or
restarting it. Client configuration files and client processes remain local; this
does not configure clients on the remote host or provide SSH machine configuration.

A blank remote client key stays blank: it does not fall back to a local API key or
the management key. The management key is never used for client traffic. The Home
client endpoints/key remain separate from management. Core lifecycle actions remain
local-only and are unavailable while Remote is selected.

## OAuth

OAuth authorization starts and polls on the selected core. Device flows can be
completed in a browser on another machine while the core polls the provider.
Authorization-code flows require the complete final callback URL to be submitted
through the existing callback input when automatic redirection cannot reach the
core. A provider redirect to `localhost` on the GUI machine does **not** reach a
listener on the remote core host. Keep callback URLs private: they contain sensitive
one-time authorization data. After submission, wait for the same core's terminal
OAuth status; callback acceptance alone is not login completion. Switching targets
invalidates pending sessions in this GUI; start authorization again.

Provider behavior follows the core's supported flows; no automatic cross-machine
callback capture or successful live provider authorization is implied by a
successful connection test. Plugin OAuth behavior additionally depends on its plugin.

## Usage compatibility mode

Remote collection uses the authenticated HTTP usage queue, never a local RESP
subscription. Local and remote histories are stored separately; remote history is
scoped by management origin, so a key rotation retains that origin's history.
Changing the server behind an unchanged origin cannot be detected automatically.

The queue removes records when read and is not a durable replay log. Use one queue
consumer: another GUI/collector can consume events first, and the core's live
subscriber behavior can prevent HTTP backfill. Lost events cannot be promised back.
After an uncertain dequeue result, remote collection pauses instead of retrying the
pop automatically. Inspect the visible collector message before explicitly resuming.

## Verification boundary

The feature's tests use isolated files, fake keys and HTTP fixtures. An isolated
CLIProxyAPI 8.0.29 also verified native connection testing and remote settings reads
across two machines. These checks do not establish live provider OAuth success,
inference quality, quota availability, or every deployment's certificate/proxy setup.

Upstream contract: [v8 management API at the bundled 8.0.29 source](https://github.com/router-for-me/CLIProxyAPI/blob/5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3/docs/management-api-v8.md).
