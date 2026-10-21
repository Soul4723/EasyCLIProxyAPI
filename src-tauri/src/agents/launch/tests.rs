    use super::*;

    #[cfg(unix)]
    #[test]
    fn codex_cli_daemon_command_preserves_executable_arguments_and_path() {
        let root = env::temp_dir().join(format!("cpa-daemon-command-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("codex fixture");
        fs::write(&executable, b"command construction fixture").unwrap();
        for action in ["version", "restart"] {
            let command = codex_cli_daemon_command(&root, Some(&executable), action).unwrap();
            assert_eq!(command.get_program(), executable.as_os_str());
            let arguments = command.get_args().map(|arg| arg.to_str().unwrap()).collect::<Vec<_>>();
            assert_eq!(arguments, ["app-server", "daemon", action]);
            let path = command.get_envs().find(|(key, _)| *key == "PATH").unwrap().1.unwrap();
            assert_eq!(env::split_paths(path).next().unwrap(), root);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_cli_daemon_restart_allows_one_restart_at_a_time() {
        let guard = begin_codex_cli_daemon_restart().unwrap();
        assert!(begin_codex_cli_daemon_restart().is_none());
        drop(guard);
        assert!(begin_codex_cli_daemon_restart().is_some());
    }

    #[test]
    fn codex_cli_daemon_status_requires_valid_running_response() {
        assert!(parse_codex_cli_daemon_status(true, br#"{"status":"running"}"#, b"").unwrap());
        for response in [
            b"not JSON".as_slice(),
            br#"{}"#,
            br#"{"status":"unknown"}"#,
            br#"{"status":"stopped"}"#,
        ] {
            assert!(parse_codex_cli_daemon_status(true, response, b"").is_err());
        }
    }

    #[test]
    fn codex_cli_daemon_status_recognizes_only_stopped_socket_errors() {
        for code in [2, 61, 111, 10061] {
            let detail = format!("Error: failed to connect to fixture/app-server-control.sock\n\nCaused by:\n    localized OS message (os error {code})");
            assert!(!parse_codex_cli_daemon_status(false, b"", detail.as_bytes()).unwrap());
            let unrelated = format!("failed to read config.toml (os error {code})");
            assert!(parse_codex_cli_daemon_status(false, b"", unrelated.as_bytes()).is_err());
        }
    }

    #[test]
    fn codex_cli_daemon_status_preserves_unsupported_and_runtime_errors() {
        for detail in [
            "error: unrecognized subcommand 'daemon'",
            "Error: daemon management is not supported on this platform",
            "Error: failed to connect to fixture/app-server-control.sock: permission denied (os error 13)",
            "Error: failed to connect to fixture/app-server-control.sock: network subsystem failed (os error 10050)",
        ] {
            let error = parse_codex_cli_daemon_status(false, b"", detail.as_bytes()).unwrap_err();
            assert!(error.contains(detail));
        }
        let error = parse_codex_cli_daemon_status(false, b"stdout-only diagnostic", b"").unwrap_err();
        assert!(error.contains("stdout-only diagnostic"));
    }

    #[test]
    fn manual_desktop_paths_drive_detection_and_restart_without_replacing_cli_paths() {
        let root = env::temp_dir().join(format!("cpa-manual-desktop-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let desktop = root.join("Custom Desktop.exe");
        let cli = root.join("custom-cli.exe");
        fs::write(&desktop, b"desktop fixture").unwrap();
        fs::write(&cli, b"cli fixture").unwrap();
        for client in [AgentClient::Codex, AgentClient::OpenCode, AgentClient::DeepSeekHarness] {
            let status = inspect_agent_config_with_executables(client, &root, 8317, "test-key", Some(&cli), Some(&desktop));
            assert!(status.installed, "{}", client.name());
            assert!(status.launch_targets.iter().any(|target| target.id == "app"), "{}", client.name());
            let cli_target = status.launch_targets.iter().find(|target| target.id == "cli").unwrap();
            assert!(cli_target.detail.contains("custom-cli.exe"));
            assert!(!cli_target.detail.contains("Custom Desktop.exe"));
        }
        for client in [AgentClient::ClaudeDesktop, AgentClient::ZCode, AgentClient::WorkBuddy] {
            let status = inspect_agent_config_with_executables(client, &root, 8317, "test-key", Some(&desktop), None);
            assert!(status.installed, "{}", client.name());
            assert_eq!(status.launch_targets.len(), 1);
            assert_eq!(status.launch_targets[0].id, "app");
            assert_eq!(status.launch_targets[0].detail, path_to_string(&desktop));
        }
        for client in [AgentClient::Codex, AgentClient::OpenCode, AgentClient::ClaudeDesktop,
            AgentClient::ZCode, AgentClient::WorkBuddy] {
            match find_desktop_restart_target(client, &root, Some(&desktop)).unwrap() {
                DesktopAppTarget::Application(path) => assert_eq!(path, desktop),
                #[cfg(target_os = "windows")]
                DesktopAppTarget::WindowsAppId(_) => panic!("manual path must take precedence"),
            }
        }
        assert!(manual_desktop_path(Some(&root.join("missing.exe"))).is_none());
        assert!(manual_desktop_path(Some(&root)).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    fn deepseek_harness_options(mode: &str) -> DeepSeekHarnessLaunchOptions {
        DeepSeekHarnessLaunchOptions {
            mode: mode.to_string(),
            web_host: None,
            web_port: None,
            open_browser: None,
            trusted_hosts: Vec::new(),
            task: None,
            profile: None,
            patches: Vec::new(),
        }
    }

    #[test]
    fn unknown_terminal_defaults_to_automatic() {
        assert_eq!(
            normalize_agent_terminal("missing-terminal"),
            DEFAULT_AGENT_TERMINAL
        );
        assert_eq!(normalize_agent_terminal(" auto "), "auto");
    }

    #[cfg(windows)]
    #[test]
    fn windows_auto_cli_uses_a_persistent_shell_for_native_and_batch_clients() {
        let directory = Path::new(r"C:\Users\Test User\project's [work]");
        for executable in [r"C:\Tools\Claude Code\claude.exe", r"C:\Tools\Claude Code\claude.cmd"] {
            let command = windows_cli_launch_command(
                Path::new(executable), "Claude Code", directory, &[], "auto",
            ).unwrap();
            assert_eq!(command.get_program(), windows_powershell_executable().as_os_str());
            let arguments = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
            assert_eq!(&arguments[..4], ["-NoLogo", "-NoProfile", "-NoExit", "-Command"]);
            assert!(arguments[4].contains("Set-Location -LiteralPath 'C:\\Users\\Test User\\project''s [work]'"));
            if executable.ends_with(".cmd") {
                // A batch launcher always goes through an explicit cmd.exe line.
                assert!(arguments[4].contains("$cpaLaunchInfo.FileName = "));
                assert!(arguments[4].contains(&format!("/D /E:ON /V:OFF /S /C \"\"{executable}\"\"")), "{}", arguments[4]);
                assert!(!arguments[4].contains(&format!("& '{executable}'")));
            } else {
                assert!(arguments[4].contains(&format!("& '{executable}'")));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_auto_cli_preserves_directory_arguments_and_environment() {
        let directory = env::temp_dir().join(format!(
            "cpa-cli-launch-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        )).join("project's [work]");
        fs::create_dir_all(&directory).unwrap();
        let batch = directory.join("test client.cmd");
        fs::write(&batch, "@echo off\r\necho %CD%\r\necho %~1\r\necho %CPA_LAUNCH_TEST%\r\nexit /b 0\r\n").unwrap();
        let native = windows_powershell_executable();
        for (executable, arguments) in [
            (batch, vec!["two words".to_string()]),
            (native, vec!["-NoProfile".into(), "-Command".into(),
                "[Console]::WriteLine([Environment]::CurrentDirectory); [Console]::WriteLine('two words'); [Console]::WriteLine($env:CPA_LAUNCH_TEST)".into()]),
        ] {
            let interactive = windows_cli_launch_command(
                &executable, "test client", &directory, &arguments, "auto",
            ).unwrap();
            // Run the same startup script without keeping a test shell open.
            let mut command = Command::new(interactive.get_program());
            command.args(interactive.get_args().filter(|arg| *arg != "-NoExit"));
            command.current_dir(&directory).env("CPA_LAUNCH_TEST", "launch-fixture");
            configure_background_command(&mut command);
            let output = match command_output_with_timeout(&mut command, Duration::from_secs(20)).unwrap() {
                CommandOutputOutcome::Completed(output) => output,
                CommandOutputOutcome::TimedOut(timeout) => panic!("{}", timeout.message("launch fixture")),
            };
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let stdout = String::from_utf8_lossy(&output.stdout);
            let lines = stdout.lines().collect::<Vec<_>>();
            assert_eq!(lines, [path_to_string(&directory).as_str(), "two words", "launch-fixture"]);
        }
        fs::remove_dir_all(directory.parent().unwrap()).unwrap();
    }

    /// A launcher whose path holds `%VAR%` or other cmd.exe metacharacters must not be
    /// expanded or run by any terminal; Windows Terminal refuses it before looking for wt.exe.
    #[cfg(windows)]
    #[test]
    fn windows_terminals_do_not_expand_or_run_launcher_paths() {
        use std::os::windows::process::CommandExt;

        let root = env::temp_dir().join(format!(
            "cpa-terminal-path-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        ));
        let directory = root.join("work");
        fs::create_dir_all(&directory).unwrap();
        let marker = directory.join("pwned.txt");
        for (name, expect_refused) in [("100%USERNAME%", true), ("a&calc", true), ("a^b", true), ("plain", false)] {
            let launcher_directory = root.join(name);
            fs::create_dir_all(&launcher_directory).unwrap();
            let shim = launcher_directory.join("shim.cmd");
            fs::write(&shim, format!("@echo off\r\necho ran> \"{}\"\r\n", directory.join("ran.txt").display())).unwrap();
            let refused = windows_cli_launch_command(&shim, "test client", &directory, &[], "windows-terminal");
            if expect_refused {
                let error = refused.unwrap_err();
                assert!(error.contains("Windows Terminal") && error.contains("path"), "{name}: {error}");
            } else if let Err(error) = refused {
                assert!(error.contains("not found"), "{name}: {error}");
            }
            for terminal in ["auto", "cmd"] {
                let _ = fs::remove_file(directory.join("ran.txt"));
                let launch = windows_cli_launch_command(&shim, "test client", &directory, &[], terminal).unwrap();
                let mut command = Command::new(launch.get_program());
                for argument in launch.get_args() {
                    let text = argument.to_string_lossy();
                    if text == "-NoExit" {
                        continue;
                    }
                    match text.strip_prefix("/D /E:ON /V:OFF /S /K ") {
                        Some(line) => command.raw_arg(format!("/D /E:ON /V:OFF /S /C {line}")),
                        None => command.arg(argument),
                    };
                }
                command.current_dir(&directory);
                configure_background_command(&mut command);
                let output = match command_output_with_timeout(&mut command, Duration::from_secs(30)).unwrap() {
                    CommandOutputOutcome::Completed(output) => output,
                    CommandOutputOutcome::TimedOut(timeout) => panic!("{}", timeout.message("launcher path fixture")),
                };
                assert!(output.status.success(), "{terminal} {name}: {}", String::from_utf8_lossy(&output.stderr));
                assert!(directory.join("ran.txt").is_file(), "{terminal} {name}: launcher did not run");
                assert!(!marker.exists() && !root.join("calc").exists(), "{terminal} {name}: path ran as a command");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// The PowerShell and Command Prompt terminals run a `.cmd` shim with text a user typed.
    /// Runs both for real and checks that the text arrives unchanged and nothing in it ran.
    #[cfg(windows)]
    #[test]
    fn windows_terminals_pass_hostile_text_to_batch_shims_as_data() {
        use std::os::windows::process::CommandExt;

        let Some(node) = env::var_os("PATH").and_then(|path| {
            env::split_paths(&path).find_map(|directory| {
                let candidate = directory.join("node.exe");
                candidate.is_file().then_some(candidate)
            })
        }) else {
            eprintln!("node.exe not found; skipping the end-to-end terminal argument test");
            return;
        };
        let directory = env::temp_dir().join(format!(
            "cpa-terminal-hostile-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        )).join("100% work's [dir] & more");
        fs::create_dir_all(&directory).unwrap();
        let marker = directory.join("pwned.txt");
        fs::write(
            directory.join("args.js"),
            "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))",
        ).unwrap();
        let shim = directory.join("agent shim.cmd");
        fs::write(&shim, format!(
            "@echo off\r\n\"{}\" \"%~dp0args.js\" \"%~dp0out.json\" %*\r\n", node.display(),
        )).unwrap();
        let hostile = vec![
            "headless task: fix it & calc".to_string(),
            format!("\" & echo owned> \"{}\" & \"", marker.display()),
            format!("x | echo owned> \"{}\"", marker.display()),
            "%PATH% and 100%".to_string(),
            "^&^|".to_string(),
            "say \"hi\" it's".to_string(),
            "\u{2018}; Start-Process calc; \u{2019}".to_string(),
            "\u{201C}smart\u{201D}".to_string(),
        ];
        for terminal in ["auto", "cmd"] {
            let _ = fs::remove_file(directory.join("out.json"));
            let launch = windows_cli_launch_command(&shim, "test client", &directory, &hostile, terminal).unwrap();
            // Run the same startup line without keeping a test shell open.
            let mut command = Command::new(launch.get_program());
            for argument in launch.get_args() {
                let text = argument.to_string_lossy();
                if text == "-NoExit" {
                    continue;
                }
                match text.strip_prefix("/D /E:ON /V:OFF /S /K ") {
                    Some(line) => command.raw_arg(format!("/D /E:ON /V:OFF /S /C {line}")),
                    None => command.arg(argument),
                };
            }
            command.current_dir(&directory);
            configure_background_command(&mut command);
            let output = match command_output_with_timeout(&mut command, Duration::from_secs(30)).unwrap() {
                CommandOutputOutcome::Completed(output) => output,
                CommandOutputOutcome::TimedOut(timeout) => panic!("{}", timeout.message("terminal fixture")),
            };
            assert!(output.status.success(), "{terminal}: {}", String::from_utf8_lossy(&output.stderr));
            assert!(!marker.exists(), "{terminal}: an argument ran as a command");
            let received: Vec<String> =
                serde_json::from_slice(&fs::read(directory.join("out.json")).unwrap()).unwrap();
            assert_eq!(received, hostile, "{terminal}");
        }
        assert!(windows_cli_launch_command(&shim, "test client", &directory, &["a\nb".to_string()], "cmd").is_err());
        fs::remove_dir_all(directory.parent().unwrap()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn powershell_waits_for_gui_helpers_and_preserves_arguments() {
        let directory = env::temp_dir()
            .join(format!(
                "cpa-powershell-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ))
            .join("User's [workspace] $value");
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("GUI helper.exe");
        let compiled = directory.parent().unwrap().join("helper.exe");
        let source = r#"
using System;
using System.IO;
using System.Threading;
class GuiHelper {
    static void Main(string[] args) {
        Thread.Sleep(350);
        File.WriteAllLines(Path.Combine(Environment.CurrentDirectory, "arguments.txt"), args);
        File.WriteAllText(Path.Combine(Environment.CurrentDirectory, "finished.txt"), "done");
    }
}
"#;
        let script = format!(
            "Add-Type -TypeDefinition {} -OutputAssembly {} -OutputType WindowsApplication -ErrorAction Stop",
            windows_powershell_single_quoted_literal(source),
            windows_powershell_single_quoted_literal(&path_to_string(&compiled)),
        );
        let run = |script: &str| {
            let mut command = Command::new(windows_powershell_executable());
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
            configure_background_command(&mut command);
            let result = match command_output_with_timeout(&mut command, Duration::from_secs(20)).unwrap() {
                CommandOutputOutcome::Completed(output) => output,
                CommandOutputOutcome::TimedOut(timeout) => panic!("{}", timeout.message("PowerShell")),
            };
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        run(&script);
        fs::rename(compiled, &executable).unwrap();
        for helper_flag in ["--cpa-antigravity-cli", "--cpa-copilot-cli"] {
            let arguments = vec![
                helper_flag.into(),
                path_to_string(&directory),
                "trailing slash \\".into(),
                "quote \" and \\\"".into(),
                "literal $value & [x] 'quoted'".into(),
                String::new(),
            ];
            let script = format!(
                "{}; if (![IO.File]::Exists({})) {{ throw 'GUI helper is still running' }}",
                windows_powershell_cli_script(&executable, &directory, &arguments).unwrap(),
                windows_powershell_single_quoted_literal(&path_to_string(
                    &directory.join("finished.txt")
                )),
            );
            run(&script);
            let received = fs::read_to_string(directory.join("arguments.txt")).unwrap();
            assert_eq!(
                received.lines().collect::<Vec<_>>(),
                arguments.iter().map(String::as_str).collect::<Vec<_>>()
            );
            fs::remove_file(directory.join("finished.txt")).unwrap();
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_process_matching_is_scoped_to_the_exact_bundle() {
        let application = Path::new("/Applications/Claude Desktop.app/Contents/MacOS/Claude");
        let processes = "10 /Applications/Claude Desktop.app/Contents/MacOS/Claude\n11 /Applications/Claude Desktop.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n12 /Applications/Claude Desktop.app.old/Contents/MacOS/Claude\n13 /Users/test/Claude Desktop.app/Contents/MacOS/Claude\n14 /usr/local/bin/claude\n";
        assert_eq!(
            desktop_process_ids_from_ps(processes, application),
            vec![10, 11]
        );
        assert!(desktop_process_ids_from_ps(
            "bad input\n-1 /opt/desktop",
            Path::new("/opt/desktop")
        )
        .is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn desktop_restart_matching_is_scoped_to_the_exact_installation() {
        let claude = PathBuf::from(r"C:\Apps\Claude's Desktop\Claude.exe");
        assert!(windows_process_matches_stop_target(
            &claude,
            Some(&claude),
            None,
            &[],
        ));
        assert!(!windows_process_matches_stop_target(
            Path::new(r"C:\Apps\Claude's Desktop.old\Claude.exe"),
            Some(&claude),
            None,
            &[],
        ));
        let zcode = PathBuf::from(r"C:\Apps\ZCode\ZCode.exe");
        assert!(windows_process_matches_stop_target(
            &zcode,
            Some(&zcode),
            None,
            &[]
        ));
        let store_root = PathBuf::from(r"C:\Program Files\WindowsApps\Anthropic.Claude_family");
        assert!(windows_process_matches_stop_target(
            &store_root.join("Claude.exe"),
            None,
            Some(&store_root),
            &[],
        ));
        assert!(!windows_process_matches_stop_target(
            Path::new(r"C:\Program Files\WindowsApps\Other\Claude.exe"),
            None,
            Some(&store_root),
            &[],
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "helper launched only by the isolated desktop restart test"]
    fn desktop_restart_test_process() {
        if let Some(marker) = env::var_os("CPA_DESKTOP_RESTART_TEST_MARKER") {
            fs::write(marker, "ready").unwrap();
            thread::sleep(Duration::from_secs(30));
        }
    }

    #[cfg(windows)]
    #[test]
    fn desktop_stop_waits_for_only_the_selected_installation() {
        struct Processes {
            children: Vec<Child>,
            directory: PathBuf,
        }
        impl Drop for Processes {
            fn drop(&mut self) {
                for child in &mut self.children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
        let directory = env::temp_dir().join(format!(
            "cpa-desktop-restart-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let executable = env::current_exe().unwrap();
        let target = directory.join("DesktopTest.exe");
        fs::copy(&executable, &target).unwrap();
        let mut processes = Processes {
            children: Vec::new(),
            directory,
        };
        for (index, application) in [&target, &executable].into_iter().enumerate() {
            let marker = processes.directory.join(format!("ready-{index}"));
            let mut command = Command::new(application);
            command
                .args([
                    "--exact",
                    "agents::launch::tests::desktop_restart_test_process",
                    "--ignored",
                ])
                .env("CPA_DESKTOP_RESTART_TEST_MARKER", &marker)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_background_command(&mut command);
            processes.children.push(crate::process_spawn::spawn(&mut command).unwrap());
            for _ in 0..100 {
                if marker.exists() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            assert!(marker.exists(), "desktop helper did not start");
        }
        let installation = DesktopAppTarget::Application(target);
        stop_other_desktop(&installation, "Test Desktop").unwrap();
        assert!(processes.children[0].try_wait().unwrap().is_some());
        assert!(
            processes.children[1].try_wait().unwrap().is_none(),
            "unrelated installation must keep running"
        );
        stop_other_desktop(&installation, "Test Desktop").unwrap();
    }

    struct HarnessRestartFixture {
        state: DeepSeekHarnessProcessState,
        directory: PathBuf,
    }

    impl Drop for HarnessRestartFixture {
        fn drop(&mut self) {
            let _ = stop_managed_deepseek_harness(&self.state);
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn harness_restart_fixture() -> HarnessRestartFixture {
        let directory = env::temp_dir().join(format!(
            "cpa-harness-restart-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(windows)]
        let (executable, arguments) = (windows_powershell_executable(), vec![
            "-NoLogo".to_string(), "-NoProfile".to_string(), "-NonInteractive".to_string(), "-Command".to_string(),
            "[IO.File]::AppendAllText((Join-Path (Get-Location).Path 'launches.txt'), ((Get-Location).Path + [Environment]::NewLine)); Start-Sleep -Seconds 60".to_string(),
        ]);
        #[cfg(unix)]
        let (executable, arguments) = (
            PathBuf::from("/bin/sh"),
            vec![
                "-c".to_string(),
                "pwd >> launches.txt; sleep 60".to_string(),
            ],
        );
        let mut options = deepseek_harness_options("web");
        options.web_port = Some(0);
        options.trusted_hosts = vec!["localhost".to_string()];
        options.patches = vec!["preserve a value with spaces".to_string()];
        let fixture = HarnessRestartFixture {
            state: DeepSeekHarnessProcessState::default(),
            directory,
        };
        launch_managed_deepseek_harness(
            &fixture.state,
            &executable,
            &fixture.directory,
            &arguments,
            "web",
            Some(&options),
        )
        .unwrap();
        wait_for_harness_launches(&fixture, 1);
        fixture
    }

    fn wait_for_harness_launches(fixture: &HarnessRestartFixture, expected: usize) {
        for _ in 0..100 {
            if fs::read_to_string(fixture.directory.join("launches.txt"))
                .unwrap_or_default()
                .lines()
                .count()
                >= expected
            {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("test process did not record launch {expected}");
    }

    #[test]
    fn harness_web_restart_preserves_snapshot_and_serializes_stop_and_spawn() {
        let fixture = harness_restart_fixture();
        let old_pid = fixture.state.status().unwrap().pid;
        let snapshot = fixture
            .state
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .launch
            .clone();
        let status = restart_managed_deepseek_harness_with(
            &fixture.state,
            |child| {
                assert!(fixture.state.process.try_lock().is_err());
                terminate_deepseek_harness_process_tree(child)
            },
            |executable, directory, arguments| {
                assert!(fixture.state.process.try_lock().is_err());
                assert_eq!(executable, snapshot.executable);
                assert_eq!(directory, snapshot.working_directory);
                assert_eq!(arguments, snapshot.arguments);
                spawn_managed_deepseek_harness(executable, directory, arguments)
            },
        )
        .unwrap();
        assert!(status.running);
        assert_ne!(status.pid, old_pid);
        wait_for_harness_launches(&fixture, 2);
        let launches = fs::read_to_string(fixture.directory.join("launches.txt")).unwrap();
        let lines = launches.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], lines[1]);
        let process = fixture.state.process.lock().unwrap();
        let options = process.as_ref().unwrap().launch.options.as_ref().unwrap();
        assert_eq!(options.web_port, Some(0));
        assert_eq!(options.trusted_hosts, vec!["localhost"]);
        assert_eq!(options.patches, vec!["preserve a value with spaces"]);
    }

    #[test]
    fn harness_restart_stop_failure_retains_process_and_does_not_spawn() {
        let fixture = harness_restart_fixture();
        let pid = fixture.state.status().unwrap().pid;
        let result = restart_managed_deepseek_harness_with(
            &fixture.state,
            |_| Err("stop failed".to_string()),
            |_, _, _| panic!("must not spawn after stop failure"),
        );
        assert_eq!(result.unwrap_err(), "stop failed");
        assert_eq!(fixture.state.status().unwrap().pid, pid);
    }

    #[test]
    fn harness_restart_spawn_failure_reports_stopped_state() {
        let fixture = harness_restart_fixture();
        let result = restart_managed_deepseek_harness_with(
            &fixture.state,
            terminate_deepseek_harness_process_tree,
            |_, _, _| Err("spawn failed".to_string()),
        );
        assert_eq!(result.unwrap_err(), "spawn failed");
        assert!(!fixture.state.status().unwrap().running);
    }

    #[test]
    fn harness_restart_rejects_missing_or_non_web_process_without_stopping_it() {
        assert!(restart_managed_deepseek_harness(&DeepSeekHarnessProcessState::default()).is_err());
        let fixture = harness_restart_fixture();
        let pid = fixture.state.status().unwrap().pid;
        fixture.state.process.lock().unwrap().as_mut().unwrap().mode = "headless".to_string();
        assert!(restart_managed_deepseek_harness(&fixture.state)
            .unwrap_err()
            .contains("Web"));
        assert_eq!(fixture.state.status().unwrap().pid, pid);
    }

    #[test]
    fn relative_launch_directory_is_rejected() {
        let error = resolve_launch_directory(Some("relative/project"), Path::new("/fallback"))
            .expect_err("relative path should be rejected");
        assert!(error.contains("absolute path"));
    }

    #[test]
    fn omitted_launch_directory_uses_fallback() {
        let fallback = if cfg!(target_os = "windows") {
            Path::new(r"C:\Users\tester")
        } else {
            Path::new("/home/tester")
        };
        assert_eq!(resolve_launch_directory(None, fallback).unwrap(), fallback);
    }

    #[test]
    fn deepseek_harness_launch_selects_the_web_profile() {
        assert_eq!(
            agent_cli_launch_arguments(AgentClient::DeepSeekHarness, None).unwrap(),
            ["web"]
        );
        assert!(agent_cli_launch_arguments(AgentClient::Codex, None)
            .unwrap()
            .is_empty());

        let targets = agent_launch_targets(
            AgentClient::DeepSeekHarness,
            Some(Path::new("dsh")),
            Some("0.1.2-rc.1"),
            false,
        );
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "cli");
        assert_eq!(targets[0].label, "DeepSeek Harness Web");
        assert_eq!(targets[0].detail, "dsh web");
    }

    #[test]
    fn deepseek_harness_web_launch_arguments_include_supported_options() {
        let mut options = deepseek_harness_options("web");
        options.web_host = Some("127.0.0.1".to_string());
        options.web_port = Some(0);
        options.open_browser = Some(false);
        options.trusted_hosts = vec!["localhost:3000".to_string(), "example.test".to_string()];
        options.patches = vec!["./extra.yml".to_string()];

        assert_eq!(
            build_deepseek_harness_launch_arguments(Some(&options)).unwrap(),
            [
                "web",
                "--patch",
                "./extra.yml",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--no-open",
                "--trusted-host",
                "localhost:3000",
                "--trusted-host",
                "example.test",
            ]
        );
    }

    #[test]
    fn deepseek_harness_non_web_profiles_build_expected_arguments() {
        for mode in ["acp", "sdk", "sdk-minimal"] {
            let options = deepseek_harness_options(mode);
            assert_eq!(
                build_deepseek_harness_launch_arguments(Some(&options)).unwrap(),
                ["--profile", mode]
            );
        }

        let mut headless = deepseek_harness_options("headless");
        headless.task = Some("review this repository".to_string());
        assert_eq!(
            build_deepseek_harness_launch_arguments(Some(&headless)).unwrap(),
            ["--profile", "headless", "review this repository"]
        );

        let mut custom = deepseek_harness_options("custom");
        custom.profile = Some("tui-dev".to_string());
        assert_eq!(
            build_deepseek_harness_launch_arguments(Some(&custom)).unwrap(),
            ["--profile", "tui-dev"]
        );
    }

    #[test]
    fn deepseek_harness_launch_options_reject_missing_required_values() {
        let headless = deepseek_harness_options("headless");
        assert!(build_deepseek_harness_launch_arguments(Some(&headless)).is_err());

        let custom = deepseek_harness_options("custom");
        assert!(build_deepseek_harness_launch_arguments(Some(&custom)).is_err());

        let options = deepseek_harness_options("web");
        assert!(agent_cli_launch_arguments(AgentClient::Codex, Some(&options)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn harness_group_stop_closes_descendant_pipes_and_preserves_sibling() {
        use std::io::{BufRead, BufReader, Read};
        use std::sync::mpsc;

        let mut sibling = Command::new("sleep").arg("30").spawn().unwrap();
        let arguments = vec!["-c".to_string(), "sleep 30 & echo ready; sleep 30".to_string()];
        // Use the production spawning path and verify it owns a private group.
        let mut child = spawn_managed_deepseek_harness(
            Path::new("/bin/sh"), Path::new("/"), &arguments,
        ).unwrap();
        assert_eq!(unsafe { libc::getpgid(child.id() as i32) }, child.id() as i32);
        // A second private group exposes a pipe inherited by both descendants.
        use std::os::unix::process::CommandExt;
        let mut piped = Command::new("sh").args(["-c", "sleep 30 & echo ready; sleep 30"])
            .process_group(0).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(piped.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut rest = Vec::new();
            let _ = sender.send(output.read_to_end(&mut rest));
        });
        let stopped = terminate_deepseek_harness_process_tree(&mut child);
        let pipes_stopped = terminate_deepseek_harness_process_tree(&mut piped);
        let eof = receiver.recv_timeout(Duration::from_secs(3));
        let sibling_alive = sibling.try_wait().unwrap().is_none();
        let _ = sibling.kill();
        let _ = sibling.wait();
        if eof.is_err() {
            let _ = crate::process_signal::signal_group(piped.id(), libc::SIGKILL);
        }
        reader.join().unwrap();
        stopped.unwrap();
        pipes_stopped.unwrap();
        assert!(eof.unwrap().is_ok(), "descendant retained the output pipe");
        assert!(sibling_alive, "unrelated sibling was signalled");
    }

    #[test]
    fn managed_deepseek_harness_state_stops_only_its_tracked_process() {
        #[cfg(windows)]
        let child = {
            let mut command = Command::new(windows_powershell_executable());
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            configure_background_command(&mut command);
            command.spawn().unwrap()
        };
        #[cfg(unix)]
        let child = {
            use std::os::unix::process::CommandExt;

            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]).process_group(0);
            command.spawn().unwrap()
        };

        let state = DeepSeekHarnessProcessState::default();
        let tracked_pid = child.id();
        *state.process.lock().unwrap() = Some(ManagedDeepSeekHarnessProcess {
            child,
            mode: "test".to_string(),
            launch: DeepSeekHarnessLaunchSnapshot {
                executable: PathBuf::new(),
                working_directory: PathBuf::new(),
                arguments: Vec::new(),
                options: None,
            },
        });

        let running = state.status().unwrap();
        assert!(running.running);
        assert_eq!(running.pid, Some(tracked_pid));
        assert_eq!(running.mode.as_deref(), Some("test"));

        stop_managed_deepseek_harness(&state).unwrap();
        assert!(!state.status().unwrap().running);
    }

    #[test]
    fn deepseek_harness_web_launch_rejects_an_occupied_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut options = deepseek_harness_options("web");
        options.web_port = Some(port);

        let error = ensure_deepseek_harness_web_endpoint_available(Some(&options)).unwrap_err();

        assert!(error.contains("is in use"), "{error}");
    }

    #[test]
    fn deepseek_harness_web_launch_allows_random_ports() {
        let mut options = deepseek_harness_options("web");
        options.web_port = Some(0);

        ensure_deepseek_harness_web_endpoint_available(Some(&options)).unwrap();
    }

    #[test]
    fn codex_exposes_independent_app_and_cli_targets() {
        let executable = Path::new("codex");
        let targets =
            agent_launch_targets(AgentClient::Codex, Some(executable), Some("1.0.0"), true);
        assert_eq!(
            targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            ["app", "cli"]
        );
    }

    #[test]
    fn opencode_desktop_is_available_without_a_cli() {
        let targets = agent_launch_targets(AgentClient::OpenCode, None, None, true);
        assert_eq!(
            targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            ["app"]
        );
        assert_eq!(targets[0].label, "OpenCode Desktop");
    }

    #[test]
    fn opencode_keeps_the_cli_as_the_default_when_both_are_installed() {
        let executable = Path::new("opencode");
        let targets = agent_launch_targets(AgentClient::OpenCode, Some(executable), None, true);
        assert_eq!(
            targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            ["cli", "app"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opencode_linux_restart_matches_the_exact_appimage_environment() {
        let directory = env::temp_dir().join(format!(
            "cpa-opencode-linux-restart-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let application = directory.join("opencode-desktop-linux-amd64.AppImage");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&application, []).unwrap();
        let mut child = Command::new("sleep")
            .arg("30")
            .env("APPIMAGE", &application)
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(100));

        stop_opencode_desktop(&application).unwrap();
        child.wait().unwrap();
        assert!(child.try_wait().unwrap().is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_and_cli_clients_get_the_correct_target_kind() {
        let executable = Path::new("agent");
        let zcode =
            agent_launch_targets(AgentClient::ZCode, Some(executable), Some("1.0.0"), false);
        let kimi = agent_launch_targets(AgentClient::KimiCode, Some(executable), None, false);
        assert_eq!(zcode[0].id, "app");
        assert_eq!(kimi[0].id, "cli");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn codex_restart_matching_is_scoped_to_the_detected_installation() {
        let executable = PathBuf::from(r"C:\Apps\Codex\Codex.exe");
        assert!(windows_process_matches_stop_target(
            &executable,
            Some(&executable),
            None,
            &["ChatGPT.exe", "Codex.exe"],
        ));
        assert!(!windows_process_matches_stop_target(
            Path::new(r"C:\Apps\Codex\helper.exe"),
            Some(&executable),
            None,
            &["ChatGPT.exe", "Codex.exe"],
        ));
        let store_root = PathBuf::from(r"C:\Program Files\WindowsApps\OpenAI.Codex_123");
        assert!(windows_process_matches_stop_target(
            &store_root.join("ChatGPT.exe"),
            None,
            Some(&store_root),
            &["ChatGPT.exe", "Codex.exe"],
        ));
        assert!(!windows_process_matches_stop_target(
            Path::new(r"C:\Program Files\WindowsApps\Other\ChatGPT.exe"),
            None,
            Some(&store_root),
            &["ChatGPT.exe", "Codex.exe"],
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn opencode_restart_matching_is_scoped_to_the_detected_installation() {
        let application = PathBuf::from(
            r"C:\Users\tester\AppData\Local\Programs\@opencode-aidesktop\OpenCode.exe",
        );
        assert!(windows_process_matches_stop_target(
            &application,
            Some(&application),
            None,
            &["OpenCode.exe"],
        ));
        assert!(!windows_process_matches_stop_target(
            Path::new(r"C:\Users\tester\AppData\Local\Programs\other\OpenCode.exe"),
            Some(&application),
            None,
            &["OpenCode.exe"],
        ));
    }
