# Remote core attachment (prototype)

Open **Home → Runtime Control → Core connection**. Choose **Remote**, enter the
core's HTTP or HTTPS origin (for example `http://core.example:8317`) and management
key, then use **Test Connection** to check management access and save. The core must already be running and
allow remote management. Enter an origin, without `/v8/management` or another path.
Choose **Local** in the same dialog to return to the saved local setup.
If this app currently owns a running local core or agent harness, stop it in
Local mode before switching. The app does not stop local processes automatically
when attaching to a remote core.

Management credentials and client API credentials are separate. This prototype
stores one connection using the app's existing GUI configuration persistence;
management and client keys are stored as plaintext, like the existing local
management key. Keep that configuration private. HTTP is supported; use a trusted network
when sending credentials over HTTP. HTTPS requires a certificate trusted by the
app's TLS client; certificate verification is not disabled for remote attachment.
Management requests connect directly, bypassing system and provider proxies.
Provider proxy settings belong to the core and are not copied from the GUI machine.

Remote status reports authenticated management reachability and the core version
header. It does not report a local process ID or installation. Starting, stopping,
restarting and updating a remote process require host control outside this app.
Local core lifecycle actions are unavailable while attached remotely.
Switch to Local before using the app's automatic updater, which also refreshes
local agent model catalogs.

## Clients on this computer

Set **Client API origin** and **Client API key** in Core connection. Use the root
origin (for example `https://clients.example:8317`), without `/v1`. These can differ
from the management origin and key. Both client fields are required for remote
client actions; leave both empty for management only. The management key never
substitutes for a client API key.

**Agent Configuration** inspects and configures supported installed clients on
the GUI computer to use this target, preserving existing backup and restore
behavior. Model fetching, client launch checks and Home model health use the
selected client API. Home displays its protocol URLs and explicit client key;
**Manage Keys** opens connection settings to change them. Saving a target reloads
the GUI to clear old requests, dialogs and cached results. Connection errors can
be repaired from Home or Agent Configuration without switching to Local. If saved
configuration cannot be read or validated, the app stays disconnected and shows
the error in Core connection; no local core is installed, adopted or started.
Save valid Remote values or explicitly choose Local to repair it.

Beginner Mode remains Local-only. DeepSeek Harness configuration and model
editing can use the remote API, but its managed launch, status, stop and restart
remain Local-only. No client files on the core server are edited.

Usage history stays on the GUI machine, separated by remote origin from local
history and other remote targets. Remote collection uses the core's HTTP usage
queue. That queue removes records when read; competing collectors share it, and
an app crash between retrieval and persistence can lose a batch.

## OAuth

The provider login runs on the selected core. For browser redirect flows, the
provider can redirect the browser to `localhost` on the GUI machine, while the
core's callback listener is on the core machine. If that page cannot connect,
copy the **complete callback URL** from the browser address bar and paste it into
the provider's callback field in the app. Submit it, then wait for login status to
confirm completion. Callback acceptance alone does not mean credentials were saved.
Do not share callback URLs: they contain temporary authorization data.

CLIProxyAPI v8.0.29 uses browser redirects for Claude, Codex, Antigravity and Devin;
Kimi, xAI and Meta use device flows. For device flows, follow the displayed URL
and code and wait for completion. Plugin OAuth behavior depends on the plugin.
Automatic callback capture across machines is not provided by this prototype.

The contracts above were checked against
[CLIProxyAPI v8.0.29](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.29/docs/management-api-v8.md).
Real provider sign-in still requires human validation; automated tests use isolated
data and do not contact provider inference endpoints.
