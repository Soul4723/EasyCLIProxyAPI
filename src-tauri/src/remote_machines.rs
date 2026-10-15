//! Constrained SSH client configuration. Core management never crosses this channel.
use super::*;
use serde_json::{json, Value};
use std::sync::OnceLock;

const PROTOCOL: u8 = 1;
const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(20);
const HELPER_COMMAND: &str = "easycli-remote-helper --remote-machine-helper-v1";
static HELPER_DATA: OnceLock<PathBuf> = OnceLock::new();
static HELPER_HOME: OnceLock<PathBuf> = OnceLock::new();
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static MACHINE_OPERATIONS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
static SELECTION: Mutex<Selection> = Mutex::new(Selection { machine_id: None, revision: 0, core_revision: 0 });

pub(crate) fn helper_data_directory() -> Option<PathBuf> { HELPER_DATA.get().cloned() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Machine {
    id: String,
    label: String,
    destination: String,
    identity: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Selection { machine_id: Option<String>, revision: u64, core_revision: u64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientCapability {
    id: String, name: String, paths: Vec<String>, supported: bool, reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MachineProbe {
    identity: String, os: String, arch: String, home: String,
    clients: Vec<ClientCapability>, limits: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum RemoteOperation {
    Capabilities,
    Inspect { client: String },
    Apply { client: String, revision: String, origin: String, api_key: String, model: String },
    Clear { client: String, revision: String },
    Backups { client: String },
    Backup { client: String, revision: String },
    Preview { client: String, backup_id: String },
    Restore { client: String, backup_id: String, revision: String },
}

impl RemoteOperation {
    fn client(&self) -> Option<&str> {
        match self {
            Self::Capabilities => None,
            Self::Inspect { client } | Self::Apply { client, .. } | Self::Clear { client, .. }
            | Self::Backups { client } | Self::Backup { client, .. } | Self::Preview { client, .. }
            | Self::Restore { client, .. } => Some(client),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request { version: u8, identity: Option<String>, operation: RemoteOperation }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response { version: u8, identity: String, result: Result<Value, String> }

fn destination_valid(destination: &str) -> Result<(), String> {
    if destination.is_empty() || destination.len() > 255 || destination.starts_with('-')
        || !destination.bytes().all(|c| c.is_ascii_alphanumeric() || b"@._-:".contains(&c))
        || destination.matches('@').count() > 1
    { return Err("Use an SSH host alias or user@host; configure port and keys in SSH config".into()); }
    Ok(())
}

fn registry_path() -> Result<PathBuf, String> { Ok(core_base_dir()?.join("remote-machines.json")) }
fn read_registry(path: &Path) -> Result<Vec<Machine>, String> {
    validate_config_path(path)?;
    match File::open(path).and_then(|file| { let mut bytes = Vec::new(); file.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut bytes)?; Ok(bytes) }) {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE => {
            let machines: Vec<Machine> = serde_json::from_slice(&bytes).map_err(|_| "Machine registry is invalid")?;
            if machines.len() > 64 { return Err("Too many enrolled machines".into()); }
            for machine in &machines {
                destination_valid(&machine.destination)?;
                if machine.id != machine_id(&machine.destination, &machine.identity) { return Err("Machine registry identity mismatch".into()); }
            }
            Ok(machines)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        _ => Err("Cannot read machine registry".into()),
    }
}
fn machine_id(destination: &str, identity: &str) -> String { sha256_bytes(format!("{destination}\0{identity}").as_bytes()) }
fn write_registry(path: &Path, machines: &[Machine]) -> Result<(), String> {
    validate_config_path(path)?;
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    validate_config_path(&temporary)?;
    let result = (|| {
        write_codex_private_file(&temporary, &serde_json::to_vec(machines).map_err(|_| "Cannot encode machine registry")?)?;
        replace_file_atomically(&temporary, path).map_err(|_| "Cannot save machine registry".to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[tauri::command]
pub(crate) fn list_remote_machines() -> Result<Vec<Machine>, String> {
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "Machine registry lock failed")?;
    read_registry(&registry_path()?)
}

fn ssh_command(destination: &str) -> Result<Command, String> {
    destination_valid(destination)?;
    let mut command = Command::new("ssh");
    command.args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no", "-o", "KnownHostsCommand=none", "-o", "PreferredAuthentications=publickey", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "--", destination, HELPER_COMMAND]);
    Ok(command)
}

// No request bytes, remote stderr, or config contents enter transport errors.
fn exchange(mut command: Command, request: &Request, deadline: Duration) -> Result<Response, String> {
    let bytes = serde_json::to_vec(request).map_err(|_| "Cannot encode helper request")?;
    if bytes.len() > MAX_REQUEST { return Err("Helper request is too large".into()); }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "OpenSSH unavailable; install/configure SSH separately")?;
    let mut stdin = child.stdin.take().ok_or("SSH stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("SSH stdout unavailable")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut output)
            .map_err(|_| ()).and_then(|_| if output.len() > MAX_RESPONSE { Err(()) } else { Ok(output) });
        let _ = sender.send(result);
    });
    thread::spawn(move || { let _ = stdin.write_all(&bytes); });
    let start = Instant::now();
    let mut output = None;
    let result = loop {
        if output.is_none() {
            match receiver.try_recv() {
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(())) => break Err("SSH helper response exceeded limit or could not be read".into()),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break Err("SSH response was interrupted".into()),
                Err(std::sync::mpsc::TryRecvError::Empty) => (),
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => break Err("SSH/helper failed. Verify existing known_hosts, batch authentication, helper availability and permissions. Configuration outcome unknown; inspect before retrying".into()),
            Ok(Some(_)) if output.is_some() => {
                break serde_json::from_slice::<Response>(output.as_ref().unwrap())
                    .map_err(|_| "Invalid helper response; matching protocol v1 helper required".to_string());
            }
            Err(_) => break Err("Cannot wait for SSH process".into()),
            _ => (),
        }
        if start.elapsed() >= deadline { break Err("SSH operation timed out; configuration outcome unknown. Inspect before retrying".into()); }
        thread::sleep(Duration::from_millis(10));
    };
    // Kill descendants too: a hung helper must not retain this GUI's pipes.
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    let response = result?;
    if response.version != PROTOCOL || request.identity.as_ref().is_some_and(|id| id != &response.identity) {
        return Err("Remote machine identity or helper protocol changed; re-probe before enrollment".into());
    }
    Ok(response)
}

fn remote_call(destination: &str, identity: Option<String>, operation: RemoteOperation) -> Result<Response, String> {
    exchange(ssh_command(destination)?, &Request { version: PROTOCOL, identity, operation }, DEADLINE)
}

#[tauri::command]
pub(crate) async fn probe_remote_machine(destination: String) -> Result<MachineProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = remote_call(&destination, None, RemoteOperation::Capabilities)?;
        let probe: MachineProbe = serde_json::from_value(response.result?).map_err(|_| "Invalid machine capabilities")?;
        if probe.identity != response.identity || probe.identity.len() != 64 || !probe.identity.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Inconsistent remote identity".into()); }
        Ok(probe)
    }).await.map_err(|_| "Machine probe failed".to_string())?
}

#[tauri::command]
pub(crate) async fn save_remote_machine(label: String, destination: String, identity: String) -> Result<Machine, String> {
    if label.trim().is_empty() || label.len() > 100 || label.chars().any(char::is_control) { return Err("Enter a machine label (1–100 characters)".into()); }
    let probe = probe_remote_machine(destination.clone()).await?;
    if probe.identity != identity { return Err("Machine identity changed since probe; probe again".into()); }
    let _lease = MACHINE_OPERATIONS.write().await;
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "Machine registry lock failed")?;
    let path = registry_path()?;
    let mut machines = read_registry(&path)?;
    let machine = Machine { id: machine_id(&destination, &identity), label: label.trim().into(), destination, identity };
    machines.retain(|m| m.id != machine.id);
    if machines.len() >= 64 { return Err("At most 64 machines may be enrolled".into()); }
    machines.push(machine.clone());
    write_registry(&path, &machines)?;
    Ok(machine)
}

#[tauri::command]
pub(crate) async fn remove_remote_machine(machine_id: String) -> Result<(), String> {
    let _lease = MACHINE_OPERATIONS.write().await;
    let _guard = REGISTRY_LOCK.lock().map_err(|_| "Machine registry lock failed")?;
    let path = registry_path()?;
    let mut machines = read_registry(&path)?;
    machines.retain(|m| m.id != machine_id);
    write_registry(&path, &machines)?;
    let mut selection = SELECTION.lock().map_err(|_| "Machine selection lock failed")?;
    if selection.machine_id.as_ref() == Some(&machine_id) { selection.machine_id = None; selection.revision += 1; }
    Ok(())
}

#[tauri::command]
pub(crate) async fn select_agent_machine(machine_id: Option<String>) -> Result<Selection, String> {
    let _lease = MACHINE_OPERATIONS.write().await;
    if let Some(id) = &machine_id {
        if !list_remote_machines()?.iter().any(|m| &m.id == id) { return Err("Machine is no longer enrolled".into()); }
    }
    let mut selection = SELECTION.lock().map_err(|_| "Machine selection lock failed")?;
    selection.machine_id = machine_id;
    selection.revision += 1;
    selection.core_revision = core_connection::revision();
    Ok(selection.clone())
}

pub(crate) fn local_agent_operation() -> Result<tokio::sync::RwLockReadGuard<'static, ()>, String> {
    let lease = MACHINE_OPERATIONS.try_read().map_err(|_| "Machine selection is changing; retry")?;
    if SELECTION.lock().map_err(|_| "Machine selection lock failed")?.machine_id.is_some() {
        return Err("Local agent operation unavailable while a remote machine is selected".into());
    }
    Ok(lease)
}

fn require_selection(selection: &Selection, machine: &str, revision: u64) -> Result<(), String> {
    if selection.machine_id.as_deref() != Some(machine) || selection.revision != revision {
        return Err("Machine selection changed; discard stale request".into());
    }
    Ok(())
}

fn validate_remote_client_origin(value: &str) -> Result<String, String> {
    let origin = core_connection::normalize_origin(value)?;
    let url = reqwest::Url::parse(&origin).map_err(|_| "Invalid client API origin")?;
    let host = url.host_str().ok_or("Missing client API host")?.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    let blocked = host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| match ip {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_unspecified(),
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified() || ip.to_ipv4().is_some_and(|ip| ip.is_loopback() || ip.is_unspecified()),
        });
    if blocked { return Err("Remote clients require a network address; localhost, loopback and unspecified client origins are unsupported".into()); }
    Ok(origin)
}

fn validate_apply_target(config: &GuiConfigFile, revision: u64, operation: &RemoteOperation) -> Result<(), String> {
    if config.target_revision != revision { return Err("Core selection changed; inspect again".into()); }
    if let RemoteOperation::Apply { origin, api_key, .. } = operation {
        if !config.core_connection.is_remote() { return Err("Select a remote core with a reachable client API origin first".into()); }
        agent_target(config)?;
        validate_remote_client_origin(origin)?;
        if origin != &config.core_connection.client_api_origin || api_key != &config.core_connection.client_api_key {
            return Err("Client origin/key do not match the selected core; refresh before applying".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_machine_request(
    gui_config_state: tauri::State<'_, GuiConfigState>, machine_id: String,
    selection_revision: u64, core_revision: u64, operation: RemoteOperation,
) -> Result<Value, String> {
    let _machine_lease = MACHINE_OPERATIONS.read().await;
    let _core_lease = core_connection::target_operation()?;
    require_selection(&*SELECTION.lock().map_err(|_| "Machine selection lock failed")?, &machine_id, selection_revision)?;
    if matches!(operation, RemoteOperation::Capabilities) { return Err("Use probe_remote_machine for capabilities".into()); }
    let config = gui_config_state.snapshot()?;
    core_connection::ensure_current(&config)?;
    validate_apply_target(&config, core_revision, &operation)?;
    let machine = list_remote_machines()?.into_iter().find(|m| m.id == machine_id).ok_or("Machine is no longer enrolled")?;
    let response = tauri::async_runtime::spawn_blocking(move || remote_call(&machine.destination, Some(machine.identity), operation))
        .await.map_err(|_| "Machine operation failed; inspect before retrying".to_string())??;
    response.result
}

// ponytail: Linux and two file-based CLI clients; extend only with remote path/transaction fixtures.
fn supported_client(id: &str) -> Result<AgentClient, String> {
    match id { "claude-code" => Ok(AgentClient::ClaudeCode), "opencode" => Ok(AgentClient::OpenCode), _ => Err("Remote prototype supports Claude Code and OpenCode only".into()) }
}

fn validate_helper_path(path: &Path, home: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.starts_with(home) { return Err("Remote path must remain inside remote home".into()); }
    validate_config_path(path)?;
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Remote paths cannot contain symbolic links".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_helper_write_path(path: &Path) -> Result<(), String> {
    if let Some(home) = HELPER_HOME.get() { validate_helper_path(path, home)?; }
    Ok(())
}

fn helper_paths(client: AgentClient, home: &Path) -> Result<Vec<PathBuf>, String> {
    let paths = agent_config_paths(client, home);
    for path in &paths { validate_helper_path(path, home)?; }
    Ok(paths)
}

fn machine_probe(home: &Path, machine_identity: &str) -> Result<MachineProbe, String> {
    let mut clients = Vec::new();
    for (id, name) in [("claude-code", "Claude Code"), ("opencode", "OpenCode")] {
        let client = supported_client(id)?;
        let paths = agent_config_paths(client, home);
        let reason = helper_paths(client, home).err().or_else(|| {
            for path in &paths {
                if path.exists() {
                    if File::open(path).is_err() { return Some("Config is not readable by this SSH account".into()); }
                    if fs::OpenOptions::new().write(true).truncate(false).open(path).is_err() {
                        return Some("Config file is not writable by this SSH account".into());
                    }
                }
                let parent = path.ancestors().skip(1).find(|p| p.exists())?;
                #[cfg(unix)] {
                    use std::os::unix::ffi::OsStrExt;
                    let encoded = std::ffi::CString::new(parent.as_os_str().as_bytes()).ok()?;
                    if unsafe { libc::access(encoded.as_ptr(), libc::W_OK | libc::X_OK) } != 0 {
                        return Some("Config directory is not writable by this SSH account".into());
                    }
                }
            }
            None
        });
        clients.push(ClientCapability { id: id.into(), name: name.into(), paths: paths.iter().map(|p| path_to_string(p)).collect(), supported: cfg!(target_os = "linux") && reason.is_none(), reason });
    }
    let identity = sha256_bytes(&serde_json::to_vec(&(PROTOCOL, machine_identity, path_to_string(home), &clients.iter().map(|c| (&c.id, &c.paths)).collect::<Vec<_>>())).map_err(|_| "Cannot identify remote machine")?);
    Ok(MachineProbe { identity, os: env::consts::OS.into(), arch: env::consts::ARCH.into(), home: path_to_string(home), clients,
        limits: vec!["Linux only; Claude Code and OpenCode config files only".into(), "No remote launch, OAuth login, desktop integration, core lifecycle, helper installation or service".into(), "Paths follow remote HOME and OpenCode environment; paths outside HOME and symlinks are rejected".into(), "SSH requires preverified known_hosts and batch key/agent authentication".into()] })
}

fn config_revision(client: AgentClient, home: &Path) -> Result<String, String> {
    let paths = helper_paths(client, home)?;
    let images = config_images(&paths)?;
    Ok(sha256_bytes(&serde_json::to_vec(&(images, recorded_agent_integration_revision(client.id(), &paths)?)).map_err(|_| "Cannot compute configuration revision")?))
}

fn expect_revision(client: AgentClient, home: &Path, expected: &str) -> Result<(), String> {
    if config_revision(client, home)? != expected { return Err("Remote configuration changed; inspect again before writing".into()); }
    Ok(())
}

fn helper_config(origin: &str, api_key: &str) -> Result<GuiConfigFile, String> {
    let origin = validate_remote_client_origin(origin)?;
    validate_agent_api_key(api_key)?;
    let mut config = GuiConfigFile::default();
    config.core_connection.mode = core_connection::ConnectionMode::Remote;
    config.core_connection.client_api_origin = origin;
    config.core_connection.client_api_key = api_key.into();
    Ok(config)
}

// Secure unchanged existing files too; transactions can legitimately skip identical bytes.
fn secure_existing_configs(paths: &[PathBuf]) -> Result<(), String> {
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        for path in paths {
            validate_helper_write_path(path)?;
            match fs::metadata(path) {
                Ok(_) => fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| "Cannot secure remote client configuration before writing")?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(_) => return Err("Cannot check remote client file permissions".into()),
            }
        }
    }
    Ok(())
}

async fn helper_operation(home: &Path, probe: &MachineProbe, operation: RemoteOperation) -> Result<Value, String> {
    if matches!(operation, RemoteOperation::Capabilities) { return serde_json::to_value(probe).map_err(|_| "Cannot encode capabilities".into()); }
    if !cfg!(target_os = "linux") { return Err("Remote helper prototype supports Linux only".into()); }
    let client = supported_client(operation.client().ok_or("Missing client")?)?;
    let paths = helper_paths(client, home)?;
    if let Some(capability) = probe.clients.iter().find(|c| c.id == client.id()) {
        if !capability.supported { return Err(capability.reason.clone().unwrap_or_else(|| "Unsupported remote capability".into())); }
    }
    match operation {
        RemoteOperation::Inspect { .. } => {
            let images = config_images(&paths)?;
            let valid = validate_client_config_images(client.id(), &images).is_ok();
            let inspection_target = helper_config("http://inspection.invalid", "inspection-placeholder")?;
            Ok(json!({"revision":config_revision(client,home)?,"paths": paths.iter().map(|p|path_to_string(p)).collect::<Vec<_>>(),
                "configured": has_recorded_agent_integration(client.id(), &paths)?, "currentModel":inspect_agent_managed_config(client, &paths, &inspection_target, "inspection-placeholder").ok().and_then(|(_, model, _)| model),
                "configExists":images.iter().any(|(_,b)|b.is_some()), "configValid":valid}))
        }
        RemoteOperation::Apply { revision, origin, api_key, model, .. } => {
            expect_revision(client, home, &revision)?;
            let model = validate_agent_model(&model)?;
            let config = helper_config(&origin, &api_key)?;
            secure_existing_configs(&paths)?;
            let models = [AgentModelOption { name: model.clone(), alias: None, is_alias: false, context_window: None, input_modalities: None, harness_metadata: None }];
            let result = apply_agent_configuration_with_oauth(client, home, &config, &api_key, &model, AgentConfigurationOptions {
                models: &models, codex_catalog: None, oauth_configuration: false, claude_code_model_mappings: None, claude_desktop_model_mappings: None,
            })?;
            serde_json::to_value(result).map_err(|_| "Cannot encode configuration result".into())
        }
        RemoteOperation::Clear { revision, .. } => {
            expect_revision(client, home, &revision)?;
            secure_existing_configs(&paths)?;
            serde_json::to_value(clear_agent_managed_configuration(client, home, &GuiConfigFile::default())?).map_err(|_| "Cannot encode restore result".into())
        }
        RemoteOperation::Backups { .. } => serde_json::to_value(list_backups(client.id(), home)?).map_err(|_| "Cannot encode backups".into()),
        RemoteOperation::Backup { revision, .. } => {
            expect_revision(client, home, &revision)?;
            serde_json::to_value(create_backup(client.id(), home)?).map_err(|_| "Cannot encode backup".into())
        }
        RemoteOperation::Preview { backup_id, .. } => {
            let plan = prepare_restore_plan(&GuiConfigFile::default(), client.id(), home, &backup_id).await?;
            serde_json::to_value(plan.preview).map_err(|_| "Cannot encode backup preview".into())
        }
        RemoteOperation::Restore { backup_id, revision, .. } => {
            let config = GuiConfigFile::default();
            let plan = prepare_restore_plan(&config, client.id(), home, &backup_id).await?;
            if plan.preview.revision != revision { return Err("Configuration changed after preview; preview again".into()); }
            secure_existing_configs(&paths)?;
            serde_json::to_value(execute_restore_plan(&config, plan, &revision).await?).map_err(|_| "Cannot encode backup restore".into())
        }
        RemoteOperation::Capabilities => unreachable!(),
    }
}

async fn handle_request(home: &Path, machine_identity: &str, request: Request) -> Response {
    let probe = match machine_probe(home, machine_identity) {
        Ok(probe) => probe,
        Err(_) => return Response { version: PROTOCOL, identity: String::new(), result: Err("Cannot resolve safe remote paths/identity".into()) },
    };
    let result = if request.version != PROTOCOL { Err("Unsupported helper protocol".into()) }
        else if !matches!(request.operation, RemoteOperation::Capabilities) && request.identity.as_deref() != Some(&probe.identity) { Err("Remote identity/home/paths changed; re-enroll before writing".into()) }
        else { helper_operation(home, &probe, request.operation).await };
    Response { version: PROTOCOL, identity: probe.identity, result }
}

#[cfg(unix)]
fn helper_write_lock(home: &Path) -> Result<File, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let path = home.join(".local/state/easycli-remote/operation.lock");
    validate_helper_path(&path, home)?;
    fs::create_dir_all(path.parent().ok_or("Missing state directory")?).map_err(|_| "Cannot create remote state directory")?;
    validate_helper_path(&path, home)?;
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| "Cannot lock remote config")?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err("Another helper operation is active; inspect and retry later".into()); }
    Ok(file)
}

pub(crate) fn run_helper() -> Result<(), String> {
    #[cfg(not(target_os = "linux"))] { return Err("Remote helper prototype supports Linux only".into()); }
    #[cfg(target_os = "linux")] {
        let home = env::var_os("HOME").map(PathBuf::from).ok_or("Remote HOME missing")?;
        if !home.is_absolute() { return Err("Remote HOME must be absolute".into()); }
        let home = fs::canonicalize(home).map_err(|_| "Cannot resolve remote HOME")?;
        let machine_id = fs::read_to_string("/etc/machine-id").map_err(|_| "Remote machine-id unavailable")?;
        if machine_id.trim().is_empty() { return Err("Remote machine-id empty".into()); }
        let identity = format!("{}:{}", machine_id.trim(), unsafe { libc::getuid() });
        let mut bytes = Vec::new();
        io::stdin().take(MAX_REQUEST as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Cannot read helper request")?;
        if bytes.len() > MAX_REQUEST { return Err("Helper request too large".into()); }
        let request: Request = serde_json::from_slice(&bytes).map_err(|_| "Invalid helper request")?;
        let data = home.join(".local/state/easycli-remote");
        validate_helper_path(&data.join(".path-check"), &home)?;
        HELPER_HOME.set(home.clone()).map_err(|_| "Helper already initialized")?;
        HELPER_DATA.set(data).map_err(|_| "Helper already initialized")?;
        let probe = machine_probe(&home, &identity)?;
        let authenticated_request = request.version == PROTOCOL && request.identity.as_deref() == Some(&probe.identity);
        let _lock = if authenticated_request && !matches!(request.operation, RemoteOperation::Capabilities) { Some(helper_write_lock(&home)?) } else { None };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "Cannot start helper runtime")?;
        let response = runtime.block_on(handle_request(&home, &identity, request));
        let bytes = serde_json::to_vec(&response).map_err(|_| "Cannot encode helper response")?;
        if bytes.len() > MAX_RESPONSE { return Err("Helper response too large".into()); }
        io::stdout().write_all(&bytes).map_err(|_| "Cannot write helper response")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
