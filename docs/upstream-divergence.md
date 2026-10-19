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

## When merging upstream

Upstream changes to these removed files have no target here. Port relevant behaviour into the section equivalents instead of restoring the old page stack or wizard.
