# Contributing

Thanks for helping. This is a fork of
[router-for-me/EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI); see the
[README](README.md) for what it is and how to build and run it.

## Branches

- Open pull requests against **`dev`**. `main` is the release branch; changes reach it only by a
  reviewed merge from `dev`. A workflow retargets pull requests opened against `main` to `dev`.
- Work on a short-lived task branch (`feat/…`, `fix/…`, `refactor/…`, `docs/…`).
- Use **one git worktree per task** so concurrent tasks do not share a checkout:
  `git worktree add ../easycli-<task> -b <branch> origin/dev`. If you build in several worktrees, point
  `CARGO_TARGET_DIR` at one directory outside the repository to share Rust build output.
- Do not force-push shared branches.

## Before you open a pull request

Run all of these from the repository root and record the results in the PR description:

```bash
bun install --frozen-lockfile
bun run check
bun run build
bun test --isolate
node tests/run-ui.cjs                # the WHOLE UI suite, never a subset
(cd src-tauri && cargo test --bin cpa-gui)
```

Docs-only changes need `bun run check` and `bun test --isolate`. Run the whole UI suite for any
change under `src/` or `tests/`; a subset can let regressions in other sections through. See
[tests/README.md](tests/README.md) for layout, adding tests and Playwright setup. If something already fails on `dev`, say so in the PR
with evidence.

Green tests against the browser mock do not show that the app works. For behaviour that depends on
the Rust backend, a core process or Remote mode, also observe the real app; see
[Observe the real debug app](docs/dev-observe.md).

## Commits and pull requests

- Use conventional prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Keep commits small and reviewable. A PR description says what changed, why, how you verified it, and
  what you deliberately left alone.
- **"No behaviour change" refactors stay separate from features.** Do not mix a move, rename or
  clean-up with a functional change in the same PR.
- **Keep upstream-facing changes separate from fork-only UI.** Changes that could be contributed to
  upstream (core handling, agent integrations, fixes) belong in their own branches and PRs, not bundled
  with the reworked sections UI. [docs/upstream-divergence.md](docs/upstream-divergence.md) lists
  where the fork differs.
- Commit no credentials, tokens or machine-specific paths. Tests and documentation use fictional data
  and `example.test` style hosts.

## Code conventions

- A new page is a section folder under `src/sections/<name>/` with `index`, `route`, `subs`, `model`,
  `mock` and `i18n`, registered in `src/shell/routes.ts`. Reuse components from `src/ui/` (browse them
  at `#/kit` in a dev build) before adding new ones.
- The frontend reaches Rust only through `src/services/platform.ts`. A new native command is
  registered in `src-tauri/src/main.rs` and, if the browser mock needs it, added to the mock.
  Commands that must not run against a remote core are fenced; see
  [docs/remote-core.md](docs/remote-core.md).
- User-visible text goes through i18n; the app ships English, Simplified Chinese, Traditional Chinese
  and Japanese.

## Mocks

The UI tests and `bun run dev` run against a browser mock of the backend. Scenarios, query
parameters (`?mock=running|stopped|empty|error`) and what the data covers are documented in
[src/mocks/README.md](src/mocks/README.md). When you add or change a native command, update the mock
so the UI still runs without Tauri, and keep it faithful to the real command's behaviour.

## Where documentation lives

| Topic | File |
| --- | --- |
| Overview, build, test, architecture | [README.md](README.md) |
| Remote core mode (authoritative) | [docs/remote-core.md](docs/remote-core.md) |
| Crash recovery of a managed core | [docs/core-recovery.md](docs/core-recovery.md) |
| Observing the real debug app | [docs/dev-observe.md](docs/dev-observe.md) |
| What differs from upstream | [docs/upstream-divergence.md](docs/upstream-divergence.md) |
| Browser mock | [src/mocks/README.md](src/mocks/README.md) |
| Release notes (per version, four languages) | [docs/release-notes/README.md](docs/release-notes/README.md) |

The Simplified Chinese and Japanese READMEs describe upstream and are outdated; update `README.md`.
