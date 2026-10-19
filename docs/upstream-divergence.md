# Upstream divergence

Intentional removals and replacements relative to router-for-me/EasyCLIProxyAPI:

- `src/pages/*`: the old Agents page stack is replaced by `src/sections/agents` (client detection, setup/model catalogs, run/manage controls, backups and Codex sessions).
- `EasyModePage` / `/easy`: the guided setup is dropped, not rebuilt. Its duplicate credential/agent workflow and independent OAuth poller are unnecessary alongside the section workspaces. Saved `/easy` links and legacy `easy` navigation redirect to Overview.

  | Former capability | Replacement or intentional removal |
  | --- | --- |
  | Two-step connect-then-configure journey | Overview's Get started checklist links to Providers and Agents; no enforced order or wizard progress. |
  | OAuth sign-in, callback/status, device code, copy/open URL | Providers OAuth workspace; no separate Easy poller. |
  | API protocol/provider, Base URL/key, test/fetch/select models, save | Providers API credential add/edit/model flows. |
  | Connected-source confirmation gate | Overview credential status and Providers link; wizard gate removed. |
  | Interactive coach, highlights, next/back/finish and gating | Removed; checklist remains. |
  | Client/model selection, apply configuration and Pi provider action | Agents client detail setup. |
  | Branded language/theme/exit bar | Shared shell language/theme controls; wizard-specific branding and exit removed. |

- `LegacyHost`: removed in #65; section routes own the application UI.
- Unused native commands `get_lan_ipv4`, `restart_codex_app`, `restart_opencode_app`, and `set_prefer_gitcode_downloads`: removed in #65.

- README screenshots, the browser-mock screenshot script (`scripts/capture-readme-screenshots.cjs`) and upstream's sponsor images (`assets/apimart-*.png`): removed in #67. The README describes this fork; screenshots will come from real-app renders. The zh-CN and ja READMEs are marked as describing upstream.
- Rust module layout (#69–#71): `src-tauri/src/main.rs`, `usage.rs` and `codex_sessions/context.rs` were split into modules without behaviour change. Upstream edits to those files must be applied to the new module files (`git diff --color-moved` on the split PRs shows where each block went).

  - `agents/configuration.rs`: configuration builders, managed removal, restoration, and client-specific formats now live in `agents/configuration/`; parent orchestration and shared format helpers remain in place.
  - `agents/discovery.rs`: paths, Pi lifecycle/packages, desktop detection, executable/version probing, model presentation, and client configuration inspection now live in `agents/discovery/`.

## When merging upstream

Upstream changes to these removed files have no target here. Port relevant behaviour into the section equivalents instead of restoring the old page stack or wizard.
