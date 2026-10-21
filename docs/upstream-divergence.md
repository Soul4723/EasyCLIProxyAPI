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

- README screenshots, the browser-mock screenshot script (`scripts/capture-readme-screenshots.cjs`) and upstream's sponsor images (`assets/apimart-*.png`): removed in #67. The README describes this fork; the screenshots in `docs/screenshots/` (added in #93) are renders of the real debug Tauri app under Xvfb against a test core, not of the browser mock. The zh-CN and ja READMEs are marked as describing upstream.
- Rust module layout (#69–#71): `src-tauri/src/main.rs`, `usage.rs` and `codex_sessions/context.rs` were split into modules without behaviour change. Upstream edits to those files must be applied to the new module files (`git diff --color-moved` on the split PRs shows where each block went).

  - `agents/configuration.rs`: configuration builders, managed removal, restoration, and client-specific formats now live in `agents/configuration/`; parent orchestration and shared format helpers remain in place.
  - `agents/discovery.rs`: paths, Pi lifecycle/packages, desktop detection, executable/version probing, model presentation, and client configuration inspection now live in `agents/discovery/`.
  - `core_runtime.rs`: child spawning, install/staging, releases/downloads, process lifecycle/control, bundled assets/metadata, supervision, rollback, archives, and startup helpers now live in `core_runtime/`; command entry points and operation locking remain in the parent where applicable.

- Rust module layout, continued (#82, #86, #87, #89): `core_config/aliases.rs` (now `core_config/aliases/`: channels, claude_desktop, entries, management, mutation, render, sources), `codex_sessions.rs` (listing, index, database, deletion, repair, process, context), `app_update.rs` (`app_update/`: archive, download, macos, manifest, portable, releases, settings) and `agents/launch.rs` (`agents/launch/`: cli, codex_daemon, deepseek, desktop, terminals) were split into modules without behaviour change. Apply upstream edits to the new module files.
- Stylesheets (#83, #84): `src/styles.css` and its override files (`src/styles/{config-settings,feature-pages,responsive-*,sidebar,theme-surfaces,ui-refinements,usage-subpages,workspace-white}.css`) are removed. Unused selectors, keyframes and variables were deleted, and component rules now live next to their component (`Component.css`). What stays global is `src/styles/{legacy-tokens,base,controls,theme-backdrop}.css`, imported in that order by `src/styles/index.css`, plus `src/ui/legacy-compat.css`. Upstream CSS edits to the removed files have no target and must be ported to the component files.
- Tests (#85): Bun tests moved under `tests/unit/<area>/` and Playwright scripts under `tests/ui/<section>/` (see `tests/README.md`). Upstream test files must be moved to the matching area.
- Process signals and spawning (#80, #88): `src-tauri/src/process_signal.rs` validates PIDs and sends Unix signals directly (never broadcast or caller-group targets), replacing external `kill` commands. `src-tauri/src/process_spawn.rs` retries spawning freshly written executables on `ETXTBSY`. New code that stops or starts child processes should use these helpers.

## When merging upstream

Upstream changes to these removed files have no target here. Port relevant behaviour into the section equivalents instead of restoring the old page stack or wizard.
