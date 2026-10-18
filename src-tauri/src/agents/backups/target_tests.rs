use super::*;

#[tokio::test]
async fn restore_unmanaged_claude_loopback_backups_without_retargeting() {
    for client in ["claude-code", "claude-desktop"] {
        for remote in [false, true] {
            for endpoint in [
                "http://localhost:11434",
                "http://127.0.0.1:11434",
                "https://localhost:11434",
                "https://127.0.0.1:11434",
                "http://[::1]:11434",
            ] {
                let home = Home::new();
                let paths = config_paths(client, &home.0).unwrap();
                let (index, content) = if client == "claude-code" {
                    (
                        0,
                        serde_json::json!({"env": {
                        "ANTHROPIC_BASE_URL": endpoint,
                        "ANTHROPIC_AUTH_TOKEN": "unmanaged-token"
                    }, "custom": "keep"}),
                    )
                } else {
                    (
                        2,
                        serde_json::json!({
                            "inferenceGatewayBaseUrl": endpoint,
                            "inferenceGatewayApiKey": "unmanaged-token",
                            "inferenceProvider": "gateway", "custom": "keep"
                        }),
                    )
                };
                save(&paths[index], content.to_string());
                let backup = create_backup(client, &home.0).unwrap();
                let expected = config_images(&paths).unwrap();
                save(&paths[index], "{}");
                let target = restore_target(remote);
                let plan = prepare_restore_plan(&target, client, &home.0, &backup.id)
                    .await
                    .unwrap_or_else(|error| panic!("{client} {endpoint}: {error}"));
                let revision = plan.preview.revision.clone();
                execute_restore_plan(
                    &GuiConfigState::new(target.clone()),
                    &target,
                    plan,
                    &revision,
                )
                .await
                .unwrap();
                assert_eq!(expected, config_images(&paths).unwrap());
            }
        }
    }
}

#[test]
fn restore_marked_claude_loopback_backups_still_require_matching_target() {
    for client in ["claude-code", "claude-desktop"] {
        let home = Home::new();
        let paths = config_paths(client, &home.0).unwrap();
        let target = restore_target(false);
        let roots = if client == "claude-code" {
            // Historical CPA markers must continue to fence old backups too.
            vec![serde_json::json!({"env": {
                "ANTHROPIC_BASE_URL": "http://localhost:11434",
                "ANTHROPIC_AUTH_TOKEN": "unmanaged-token",
                (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV): "1"
            }})]
        } else {
            vec![
                serde_json::json!({}),
                serde_json::json!({}),
                serde_json::json!({
                    "inferenceGatewayBaseUrl": "http://localhost:11434",
                    "inferenceGatewayApiKey": "unmanaged-token"
                }),
                serde_json::json!({"entries": [{"id": CLAUDE_DESKTOP_PROFILE_ID}]}),
            ]
        };
        let images = paths
            .into_iter()
            .zip(
                roots
                    .into_iter()
                    .map(|root| Some(root.to_string().into_bytes())),
            )
            .collect();
        assert!(super::super::target::validate_restore_target(&target, client, &images).is_err());
    }
}
