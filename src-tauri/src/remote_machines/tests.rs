use super::*;

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let path = env::temp_dir().join(format!("cpa-machine-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Home { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

async fn request(home: &Home, identity: &str, operation: RemoteOperation) -> Result<Value, String> {
    // Exercise protocol serialization as well as real native transaction handlers.
    let input = serde_json::to_vec(&Request { version: PROTOCOL, identity: Some(identity.into()), operation }).unwrap();
    let decoded = serde_json::from_slice(&input).unwrap();
    let response = handle_request(&home.0, "fixture-machine:1000", decoded).await;
    let output = serde_json::to_vec(&response).unwrap();
    assert!(!String::from_utf8_lossy(&output).contains("deliberate-client-secret"));
    serde_json::from_slice::<Response>(&output).unwrap().result
}

#[tokio::test]
async fn helper_configures_both_clients_preserves_edits_and_restores_backups() {
    let home = Home::new();
    let identity = machine_probe(&home.0, "fixture-machine:1000").unwrap().identity;
    for id in ["claude-code", "opencode"] {
        let client = supported_client(id).unwrap();
        let path = helper_paths(client, &home.0).unwrap().remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"theme":"dark","keep":17}"#).unwrap();
        let inspection = request(&home, &identity, RemoteOperation::Inspect { client:id.into() }).await.unwrap();
        assert!(inspection["configValid"].as_bool().unwrap());
        let original_revision = inspection["revision"].as_str().unwrap().to_string();
        let backup = request(&home, &identity, RemoteOperation::Backup { client:id.into(),revision:original_revision.clone() }).await.unwrap();
        let apply = || RemoteOperation::Apply { client:id.into(), revision:original_revision.clone(), origin:"http://core.invalid:8317".into(), api_key:"deliberate-client-secret".into(), model:"fixture-model".into() };
        request(&home, &identity, apply()).await.unwrap();
        assert!(request(&home, &identity, apply()).await.unwrap_err().contains("changed"));
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["theme"], "dark");
        let rendered = value.to_string();
        assert!(rendered.contains("core.invalid:8317") && rendered.contains("deliberate-client-secret"));
        value["userAdded"] = json!(true);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let inspection = request(&home, &identity, RemoteOperation::Inspect { client:id.into() }).await.unwrap();
        request(&home, &identity, RemoteOperation::Clear { client:id.into(),revision:inspection["revision"].as_str().unwrap().into() }).await.unwrap();
        let cleared: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(cleared["theme"], "dark");
        assert_eq!(cleared["userAdded"], true);
        assert!(!cleared.to_string().contains("deliberate-client-secret"));
        let backup_id = backup["id"].as_str().unwrap().to_string();
        let preview = request(&home, &identity, RemoteOperation::Preview { client:id.into(), backup_id:backup_id.clone() }).await.unwrap();
        let revision = preview["revision"].as_str().unwrap().to_string();
        fs::write(&path, br#"{"externalEdit":true}"#).unwrap();
        assert!(request(&home, &identity, RemoteOperation::Restore { client:id.into(),backup_id:backup_id.clone(),revision }).await.is_err());
        let preview = request(&home, &identity, RemoteOperation::Preview { client:id.into(), backup_id:backup_id.clone() }).await.unwrap();
        request(&home, &identity, RemoteOperation::Restore { client:id.into(),backup_id,revision:preview["revision"].as_str().unwrap().into() }).await.unwrap();
        let restored: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(restored, json!({"theme":"dark","keep":17}));
    }
}

#[tokio::test]
async fn helper_rejects_wrong_identity_version_client_and_invalid_config_without_writes() {
    let home = Home::new();
    let probe = machine_probe(&home.0, "fixture-machine:1000").unwrap();
    let inspect = || RemoteOperation::Inspect { client:"claude-code".into() };
    assert!(request(&home, "other-machine", inspect()).await.unwrap_err().contains("identity"));
    assert_ne!(probe.identity, machine_probe(&home.0, "different-machine:1000").unwrap().identity);
    assert!(request(&home, &probe.identity, RemoteOperation::Inspect {client:"codex".into()}).await.is_err());
    let response = handle_request(&home.0,"fixture-machine:1000", Request { version:99, identity:Some(probe.identity.clone()), operation:inspect() }).await;
    assert!(response.result.err().unwrap().contains("protocol"));
    let path = home.0.join(".claude/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"broken config").unwrap();
    let inspection = request(&home, &probe.identity, inspect()).await.unwrap();
    assert_eq!(inspection["configValid"],false);
    assert!(request(&home,&probe.identity,RemoteOperation::Apply {client:"claude-code".into(),revision:inspection["revision"].as_str().unwrap().into(),origin:"https://core.invalid".into(),api_key:"deliberate-client-secret".into(),model:"fixture".into()}).await.is_err());
    assert_eq!(fs::read(path).unwrap(),b"broken config");
}

#[test]
fn local_machine_and_core_guards_reject_stale_or_wrong_target() {
    let selection = Selection { machine_id:Some("one".into()),revision:5,core_revision:8 };
    assert!(require_selection(&selection,"one",5).is_ok());
    assert!(require_selection(&selection,"two",5).is_err());
    assert!(require_selection(&selection,"one",4).is_err());
    let mut config = helper_config("http://core.invalid:8317","client-key").unwrap();
    config.target_revision=8;
    let apply = |origin:&str,key:&str| RemoteOperation::Apply {client:"claude-code".into(),revision:"x".into(),origin:origin.into(),api_key:key.into(),model:"test".into()};
    assert!(validate_apply_target(&config,8,&apply("http://core.invalid:8317","client-key")).is_ok());
    assert!(validate_apply_target(&config,7,&apply("http://core.invalid:8317","client-key")).is_err());
    assert!(validate_apply_target(&config,8,&apply("http://other.invalid","client-key")).is_err());
    assert!(validate_apply_target(&config,8,&apply("http://core.invalid:8317","management-key")).is_err());
    config.core_connection.mode=core_connection::ConnectionMode::Local;
    assert!(validate_apply_target(&config,8,&apply("http://core.invalid:8317","client-key")).is_err());
}

#[test]
fn registry_roundtrip_and_protocol_reject_injection_and_unknown_fields() {
    let home=Home::new();
    let path=home.0.join("machines.json");
    let machine=Machine { id:machine_id("fixture","identity"),label:"Fixture".into(),destination:"fixture".into(),identity:"identity".into() };
    write_registry(&path,&[machine.clone()]).unwrap();
    assert_eq!(read_registry(&path).unwrap()[0].id,machine.id);
    assert!(destination_valid("user@host").is_ok());
    for value in ["-oProxyCommand=evil","host;touch /tmp/no","host name","user@host@other","host\n"] { assert!(destination_valid(value).is_err()); }
    assert!(serde_json::from_str::<Request>(r#"{"version":1,"identity":null,"operation":{"kind":"shell","command":"true"}}"#).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"version":1,"identity":null,"operation":{"kind":"inspect","client":"opencode","path":"/tmp/x"}}"#).is_err());
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777,0o600);
    }
}

#[cfg(unix)]
#[test]
fn ssh_is_fixed_strict_and_transport_bounds_timeout_output_and_failure() {
    let command=ssh_command("fixture-host").unwrap();
    let args=command.get_args().map(|a|a.to_str().unwrap()).collect::<Vec<_>>();
    assert!(args.contains(&"StrictHostKeyChecking=yes"));
    assert!(args.contains(&"BatchMode=yes"));
    for setting in ["VerifyHostKeyDNS=no", "KnownHostsCommand=none", "PreferredAuthentications=publickey", "ForwardAgent=no", "ForwardX11=no", "ControlPath=none"] {
        assert!(args.contains(&setting));
    }
    assert_eq!(args.last().unwrap(),&HELPER_COMMAND);
    let request=Request {version:PROTOCOL,identity:None,operation:RemoteOperation::Capabilities};
    let shell=|script:&str| {let mut c=Command::new("sh");c.args(["-c",script]);c};
    let start=Instant::now();
    assert!(exchange(shell("sleep 10"),&request,Duration::from_millis(50)).err().unwrap().contains("timed out"));
    assert!(start.elapsed()<Duration::from_secs(2));
    assert!(exchange(shell("head -c 2097153 /dev/zero"),&request,Duration::from_secs(2)).is_err());
    assert!(exchange(shell("echo deliberate-client-secret >&2; exit 1"),&request,Duration::from_secs(2)).err().unwrap().contains("SSH/helper failed"));
    assert!(exchange(shell("printf '%s' '{\"version\":99,\"identity\":\"x\",\"result\":{\"Ok\":null}}'"),&request,Duration::from_secs(2)).err().unwrap().contains("protocol"));
}

#[cfg(unix)]
#[test]
fn symlink_paths_and_parallel_helper_writes_fail_closed() {
    let home=Home::new();
    let other=Home::new();
    std::os::unix::fs::symlink(&other.0,home.0.join(".claude")).unwrap();
    assert!(helper_paths(AgentClient::ClaudeCode,&home.0).is_err());
    let first=helper_write_lock(&home.0).unwrap();
    assert!(helper_write_lock(&home.0).is_err());
    drop(first);
    assert!(helper_write_lock(&home.0).is_ok());
}

#[tokio::test]
async fn machine_selection_waits_for_leases_and_blocks_local_commands() {
    let lease = MACHINE_OPERATIONS.read().await;
    let change = tokio::spawn(select_agent_machine(None));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!change.is_finished());
    assert!(local_agent_operation().is_err());
    drop(lease);
    let selection = change.await.unwrap().unwrap();
    assert_eq!(selection.machine_id, None);
    assert!(local_agent_operation().is_ok());
    let mut current = SELECTION.lock().unwrap();
    current.machine_id = Some("fixture".into());
    drop(current);
    let blocked = local_agent_operation().is_err();
    SELECTION.lock().unwrap().machine_id = None;
    assert!(blocked);
}

#[tokio::test]
async fn core_alias_read_works_while_remote_agent_machine_selected() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut bytes = [0; 8192];
        let size = socket.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..size]).to_ascii_lowercase();
        assert!(request.starts_with("get /v8/management/config.yaml "));
        assert!(request.contains("authorization: bearer fixture-management-secret\r\n"));
        let body = "oauth-model-alias:\n  codex:\n    - name: gpt-fixture\n      alias: fixture-alias\n";
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/yaml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let mut config = helper_config("http://client.invalid", "fixture-client-key").unwrap();
    config.core_connection.remote_management_origin = origin;
    config.core_connection.remote_management_key = "fixture-management-secret".into();
    let previous = SELECTION.lock().unwrap().clone();
    SELECTION.lock().unwrap().machine_id = Some("remote-fixture".into());
    assert!(local_agent_operation().is_err());
    let aliases = read_core_thinking_aliases(&config).await;
    *SELECTION.lock().unwrap() = previous;
    let aliases = aliases.unwrap();
    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0].alias, "fixture-alias");
    server.join().unwrap();
}

#[cfg(unix)]
#[test]
fn helper_state_rejects_relocated_root_alias_before_lock_or_write() {
    let home = Home::new();
    let outside = Home::new();
    fs::create_dir_all(home.0.join(".local/state")).unwrap();
    std::os::unix::fs::symlink(&outside.0, home.0.join(".claude")).unwrap();
    std::os::unix::fs::symlink(&outside.0, home.0.join(".local/state/easycli-remote")).unwrap();
    assert!(validate_helper_path(&home.0.join(".local/state/easycli-remote/.path-check"), &home.0).is_err());
    assert!(helper_write_lock(&home.0).is_err());
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
}

#[test]
fn remote_client_origins_reject_local_addresses_without_dns_and_keep_network_http() {
    for origin in ["http://localhost:8317", "https://LOCALHOST.", "http://api.localhost", "http://api.localhost.", "http://127.0.0.1", "http://127.42.3.9", "http://127.1", "http://2130706433", "http://0.0.0.0", "http://[::1]", "http://[::]", "http://[::ffff:127.0.0.1]", "http://[::127.0.0.1]"] {
        assert!(validate_remote_client_origin(origin).is_err(), "accepted {origin}");
        let mut config = helper_config("http://core.invalid", "client-key").unwrap();
        config.core_connection.client_api_origin = origin.into();
        let operation = RemoteOperation::Apply { client:"opencode".into(),revision:"fixture".into(),origin:origin.into(),api_key:"client-key".into(),model:"fixture".into() };
        assert!(validate_apply_target(&config, 0, &operation).is_err());
        assert!(helper_config(origin, "client-key").is_err());
    }
    for origin in ["http://100.64.0.2:8317", "http://192.168.1.2", "http://10.0.0.1", "http://203.0.113.5", "https://core.example", "http://localhost.example", "http://[fd00::2]:8317", "http://[2001:db8::1]"] {
        assert!(validate_remote_client_origin(origin).is_ok(), "rejected {origin}");
    }
}

#[cfg(unix)]
#[test]
fn capabilities_reject_readable_but_unwritable_existing_files_without_modification() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new();
    for id in ["claude-code", "opencode"] {
        let path = helper_paths(supported_client(id).unwrap(), &home.0).unwrap().remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"unrelated":"keep"}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(File::open(&path).is_ok());
        assert!(fs::OpenOptions::new().write(true).truncate(false).open(&path).is_err(), "Run permission fixtures as an unprivileged account");
        let probe = machine_probe(&home.0, "fixture-machine:1000").unwrap();
        let capability = probe.clients.iter().find(|c| c.id == id).unwrap();
        assert!(!capability.supported);
        assert!(capability.reason.as_ref().unwrap().contains("not writable"));
        assert_eq!(fs::read(&path).unwrap(), br#"{"unrelated":"keep"}"#);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(machine_probe(&home.0, "fixture-machine:1000").unwrap().clients.iter().find(|c| c.id == id).unwrap().supported);
    }
}
