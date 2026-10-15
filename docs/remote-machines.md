# Remote agent machines (prototype)

Agents can select Local or an enrolled SSH machine. Core selection remains separate:
choose the remote core in Runtime Control first. Remote Apply requires that core's
client API origin and client key. SSH-machine Apply rejects `localhost`, `.localhost`
names, literal loopback IPs and unspecified addresses (`0.0.0.0` / `::`), since
these change meaning on another host. Use the core's network address, including
when configuring the core host itself. HTTP public/private origins remain allowed;
HTTPS verification stays enabled. Hostnames are not DNS-resolved by this guard.
Management API credentials never go to the helper.

Only Linux remote accounts, Claude Code and OpenCode are supported. Configuration
uses the remote account's HOME and OpenCode environment, preserves unrelated fields,
and uses the same transaction, rollback, manual backup and restore code as Local.
Paths outside HOME and symbolic links are rejected, including nested backup and
integration snapshot paths under helper state.
Existing files must permit a non-truncating write-open by the SSH account; probe
reports readable but unwritable files as unsupported without changing their bytes.
The helper does not check that clients are installed, fetch models, perform inference,
launch clients, install
integrations, log in with OAuth, control the core, or deploy services. Enter an
existing model ID deliberately.

## Prerequisites

Use system OpenSSH with an existing, independently verified known_hosts entry and
working batch key/SSH-agent authentication. Configure nonstandard ports, usernames,
and keys in SSH config; enter a host alias or `user@host` in the GUI. Unknown or
changed host keys fail closed. There is no automatic host-key acceptance or password
prompt. Existing SSH configuration is trusted; it may contain proxy commands.

On the isolated remote test machine, make this build's application binary available
on the noninteractive SSH PATH as `easycli-remote-helper`. The fixed command is
`easycli-remote-helper --remote-machine-helper-v1`. It exits after one bounded JSON
request over stdin/stdout, before GUI initialization; it opens no listener. The same
platform binary still needs its normal dynamic libraries. No daemon or installer
is provided. Helper versions must speak protocol v1. Remote state and sensitive
backups live in `~/.local/state/easycli-remote/`, separate from any remote GUI/core.

## Workflow and recovery

Probe the SSH destination, review identity, HOME and supported paths, then name and
save it. Enrollment rechecks identity without editing client configuration. Saved
identities are independent of core selection. The identity includes Linux machine-id,
account ID, canonical HOME and resolved client paths; moving HOME or changing a
client path requires enrollment again. SSH host authentication remains OpenSSH's
known_hosts responsibility. Protect the remote account and local SSH configuration.

Inspect before Apply, Clear or creating a backup. Apply sends only the deliberate
client key through encrypted stdin, never arguments or a management key. Clear
removes the managed integration while preserving later unrelated edits. Manual
backup restore replaces the backed-up files after preview; changes after preview
are rejected. Backup files may contain credentials and must stay private. Helper writes secure
client files as mode 0600 before writing credential bytes, including restore;
unchanged existing files are tightened too.

Machine selection waits for an in-flight operation. Stale machine/core selections,
changed config revisions and wrong identities fail closed. Remote filesystem
operations serialize through an account-local lock; Local operations are blocked
while a remote machine is selected. Core plugins continue using the existing core
management API and are unrelated to SSH machine selection.

SSH has a 5-second connect timeout and 20-second total operation deadline, with
64 KiB requests and 2 MiB responses. Errors never echo remote stderr or request
payloads. A disconnect or timeout can occur after a commit: outcome is unknown.
Reconnect and inspect before retrying; writes are never retried automatically.
If a transaction reports rollback failure, preserve files/state and recover from a
manual backup. Offline machines keep their enrolled identities. Removing a machine
forgets its local enrollment; it does not delete remote files or backups.

## Isolated validation

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline remote_machines::tests -- --test-threads=1
cargo build --manifest-path src-tauri/Cargo.toml --locked --offline
python3 src-tauri/tests/remote-machine-fixture.py /absolute/path/to/target/debug/cpa-gui
```

Run permission fixtures as an unprivileged account. The fixture uses temporary
HOME/config/state and a fake SSH executable. It invokes
the real headless helper and exercises both supported clients, preservation,
backups, stale writes, restore and failure cases. It never connects to a host or
changes real client configuration.
