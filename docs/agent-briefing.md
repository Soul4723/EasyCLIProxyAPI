# Agent briefing

`cpa-brief` is a command that gives a coding agent a short, cached answer to: *how much quota
headroom does each provider have, when does it come back, and which models can I route to right
now?* An agent runs it before it plans or delegates, to choose between a wide parallel run and a
slow, cheap one. It is a briefing, not a dashboard. The agent-facing instructions are in
[skills/cpa-brief/SKILL.md](../skills/cpa-brief/SKILL.md).

```
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h11m wk=81%~3d2h | claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5-20251001 +5
codex low 1/1 5h=8%~20m wk=40%~1d23h | gpt-6.1-sol codex-auto-review cool:gpt-6-luna~3m
guide: swarm=claude light=codex(5h=8%~20m)
```

This sample is verbatim output from the built binary against fictional fixture data on lab1.

## How it works

The command is the app binary itself: `cpa-gui --brief [--json] [--accounts] [--provider P] [--model M]`.
Filter values may contain only ASCII letters, digits and `. _ : / -` (the Windows `.cmd` launcher
forwards `%*`, which `cmd` re-parses); anything else exits 2, as does an unknown option.
`main` handles `--brief` before the single-instance lock, GTK and the webview, so it starts fast,
never opens a window and works whether or not the app is running. When the app starts it writes a
tiny launcher that runs the current binary with `--brief`; the skill names the launcher, not the binary:

| OS | Launcher |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.cpa.gui/agent/cpa-brief` |
| macOS | `~/Library/Application Support/com.cpa.gui/agent/cpa-brief` |
| Windows | `%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd` |

PowerShell uses `& "$env:APPDATA\com.cpa.gui\agent\cpa-brief.cmd"`; `%APPDATA%` is the `cmd.exe` form.

The same folder holds three cache files, each written by one party only:

| File | Written by | Contains | Refreshed |
| --- | --- | --- | --- |
| `quota.json` | the running app (`agent_briefing_publish`) | per account: provider, masked label, plan, 5h/weekly/other windows (remaining %, absolute reset time), balance, read time | when the app's quota cache changes (debounced) |
| `core.json` | the `--brief` command | per credential: provider, disabled, unavailable, retry time, cooldowns, model ids; whether the core answered | by a query, when older than 60 s (15 s after a failure) |
| `quota-cli.json` | the `--brief` command | the same per-account quota shape as `quota.json`, for Claude, Codex and Devin; last failed read per account | by a query, for accounts with no read newer than 5 min (15 min after a failed read) |

Both are `0600`, keyed by the core's management origin; a cache from another core is ignored. The command reads
the app's saved `config.toml` (read-only, next to the executable) to find the core and its management key. If the
app has never saved settings (or they cannot be read) it does not dial anything and ignores any cached
files: it prints `no briefing data yet` and exits 1.

## Data sources

- **Quota windows** come from the app's quota cache (`src/services/quotaCache.ts`), which the Overview
  and Quota pages fill by asking the providers through the core; a small module
  (`src/sections/quota/agentBriefing.ts`) sends a masked snapshot of it over one fenced command. When an
  enabled Claude, Codex or Devin account has no read newer than 5 minutes (from the app or the command),
  the command reads it itself (`src-tauri/src/agent_brief/quota_fetch.rs`): one `GET /credentials`, then
  per account the same read-only usage request the app makes, through the core's
  `POST /v8/management/requests/api-call` (the core inserts the token). Only three URLs are allowed:
  Claude `api/oauth/usage`, Codex `backend-api/wham/usage` and Devin `GetUserStatus`; no inference
  endpoint. The two snapshots are merged per account and the newest read wins. Antigravity, xAI and Kimi
  quota still come only from the app. The command does not read Claude's plan endpoint; it keeps the last
  known plan.
- **Availability and cooldowns** come from the core's `GET /v8/management/credentials`
  (disabled, unavailable, retry time, per-credential and per-model `cooldowns`).
- **Models** come from `GET /v8/management/credentials/models?name=` for each enabled credential,
  cached for 15 minutes per credential. A model is routable when an account that can route now serves it
  without a model cooldown; otherwise it is listed as `cool:` with the time the first serving account
  recovers. The default text samples the newest model per family, at most four, ordered by newest version
  (alphabetically by family for ties); image models are omitted and `+N` counts additional routable models.
  `--model` lists every match and `--json` lists all models. A model omitted from the default sample may
  still be routable; check it with `--model`. This is exact per credential, which `GET /v1/models` is not:
  that list has no provider and keeps quota-cooled models listed.
- Model-list attempts, including failed reads, are timestamped. With over 32 stale credential lists, later
  refreshes pick up remaining credentials rather than retrying the same failures each minute.
- The core's own quota `signals` (raw rate-limit response headers for Claude, Codex and Devin) are not
  used: they are provider-specific strings, present only after real traffic, with no stable window shape.

## Freshness

- Relative times ("resets in 1h12m") are computed when you run the command from absolute timestamps, so
  cached data never shows a wrong countdown. A window whose reset passed since the read prints `5h=reset`
  and counts as full.
- Every output states the age of the oldest quota read among displayed accounts and flags it `stale` after 30 minutes.
- Claude, Codex and Devin quota is at most about 5 minutes old while the core is up (an account whose
  read failed is retried after 15 minutes). Other providers are as fresh as the app's last read. With the
  core down, the last reads are served with their age.
- `core=up` means core data was refreshed within 60 seconds. When unreachable, output says
  `core=down cached=<age>`; if refresh failed for another reason, it says `core=stale cached=<age>`.
  Data older than the TTL is never marked live. Down or stale core state lists no models.

## Guidance line

Arithmetic on the numbers, with fixed thresholds in `render.rs`: windows shown come from the selected
headroom account, so status and guidance agree. Under 0.5% is exhausted and renders `<1%`; if its reset is
unknown, output says `back=?` and the guide uses `avoid`. Displayed whole percentages are floored; status
and guidance use the unrounded percentage. A provider with at least 50% on its tightest
window and status `ok` is `swarm`; below that, or `low` (under 20%), is `light`; a provider with no usable
account is `wait` if it recovers within 30 minutes, otherwise `avoid`. Providers with no quota numbers are
omitted from the guide.

## Privacy

Masked labels (the same masking as privacy mode, applied before the data leaves the webview and
validated again in Rust), provider names, plans, percentages, times, model ids and a balance string are
stored or printed. The quota/core caches also retain an `auth_index` only when it is 1–64 ASCII letters,
digits, `_` or `-`, so quota and core records can be joined. Core v8 generates this value as the first
eight bytes of SHA-256(seed), in hex, which is pseudonymous; the character check itself does not prove
that an arbitrary incoming value is anonymous. Email-, path/filename-, and JWT-shaped values containing
disallowed characters are rejected. The management key from the app's own config is used for the two
core reads and never printed.

## Cost

- A query reads three small files. When `core.json` is older than the TTL it makes one `GET /credentials`
  (plus model requests for credential lists older than 15 minutes), bounded to 4 s each and 32 model reads
  per refresh. Concurrent callers wait on a lock file and share one refresh (checked again under the lock);
  an overall 25 s deadline bounds the refresh.
- Quota reads follow the same discipline with their own lock (`quota.lock`): at most 24 accounts, 6 at a
  time, 10 s each, 20 s overall. Callers that find the lock held wait up to 5 s and then use what is cached.
  Without a writable cache folder the command never asks for quota (it could not record backoff).
- Nothing runs when nobody asks: the app has a quota-cache subscription with a one-shot debounce, and the
  command polls briefly only while waiting for another command's lock. The frontend sends one debounced IPC
  per quota-cache change.
- A query never sends an inference request and never starts or stops a core.

## Limits (not in this version)

Refreshing Antigravity, xAI and Kimi quota while the app is idle; balances for API-key providers; usage history in the
briefing; any UI. In Remote mode the data comes from the remote core, and quota is cached per core address.
