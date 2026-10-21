# Release channels

Fork builds use three independent channels. No branding is stored per branch.

| Channel | Branch | App identifier | Default local core port | Version suffix |
| --- | --- | --- | --- | --- |
| Stable | `main` | `com.cpa.gui` | 8317 | `-fork.N` |
| Beta | `staging` | `com.cpa.gui.beta` | 8318 | `-beta.N` |
| Dev | `dev` | `com.cpa.gui.dev` | 8319 | `-dev.N` |

Only the owner merges into `main` and `staging`; agents open PRs. Install Linux/Windows
portable packages in separate directories: configuration, credentials, core and history
live beside each executable. macOS stores these under
`~/Library/Application Support/<app identifier>`. Webview storage is identifier-specific.
Channels do not share data automatically. Explicit user-selected external paths can still
be shared; ports and existing settings are never migrated or overwritten.

Stable keeps the existing name, logo and window appearance. Dev has a small red DEV tag;
Beta has an amber BETA tag. Native icons and titles have matching channel branding.
`node scripts/channel.mjs stable|beta|dev` generates an ignored Tauri config overlay and
platform icons from the original or committed recoloured PNGs. Build with
`bun tauri build --config src-tauri/tauri.channel.conf.json --no-bundle`.
Set `VITE_CHANNEL` to the same channel for the frontend, and `APP_RELEASE_CHANNEL` for Rust.

## Cut a fork release

`.github/workflows/fork-release.yml` is fork-only, building Linux, Windows and macOS
on amd64 and aarch64. Pushes create **drafts**, never public releases. To cut a release:

```bash
gh workflow run fork-release.yml --repo Soul4723/EasyCLIProxyAPI \
  --ref main -f channel=stable -F draft=true
```

Choose `beta`/`dev` for the other channels. The source defaults to the channel branch;
`source_ref` overrides it for draft verification only. Set `draft=false` explicitly to
publish from the canonical branch and advance its updater feed. Drafts never modify feeds.
The base version is the highest strict `vX.Y.Z` directory in the source's
`docs/release-notes/`, compared numerically, with the Cargo package base version as a
fallback when no such directories exist. The channel suffix and GitHub workflow run
number (`N`) are appended. Numeric suffixes compare correctly (9 < 10), and a newer base wins.
Stable's `-fork.N` is a SemVer prerelease, lower than the same unsuffixed upstream version;
install a fork package manually when switching from upstream. Reruns cannot overwrite an
existing version release; dispatch again for a new version.

Before building, the workflow pushes an immutable `v<version>` tag at the pinned source
SHA using `GITHUB_TOKEN`. This keeps a source ref available if the branch advances during
the build; release creation requires that tag to exist. The source tag is public even for
a draft, but draft binary assets remain private and feeds stay unchanged. A failed or
cancelled build leaves its version tag behind; inspect and remove that tag manually if
no release uses it. A rerun cannot replace the tag; dispatch a new run instead.

The workflow bakes in `APP_RELEASE_REPOSITORY=Soul4723/EasyCLIProxyAPI`. Each channel reads
`https://github.com/Soul4723/EasyCLIProxyAPI/releases/download/channel-<channel>/portable-update-<platform>.json`
(macOS uses `portable-update-darwin-v2.json`). These existing portable manifests point to
immutable `v<version>` package URLs with SHA-256 and size. Only feed manifest assets move;
older versions cannot roll a feed back. Feeds are prereleases, not GitHub's `latest`.
The upstream release workflow is unchanged; tags created using `GITHUB_TOKEN` do not
recursively trigger it.

macOS packages are ad-hoc signed, not notarized. Fork CI explicitly compiles
`APP_ALLOW_UNNOTARIZED_UPDATES=true`; updates retain code-signature and manifest integrity
checks but skip notarization assessment. Initial installation may require macOS approval.
Without these build settings, the app retains upstream's updater URL and notarization checks.
