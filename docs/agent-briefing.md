# Agent briefing

`cpa-brief` is a command that gives a coding agent a short, cached answer to: *how much quota
headroom does each provider have, when does it come back, and which models can I route to right
now?* An agent runs it before it plans or delegates, to choose between a wide parallel run and a
slow, cheap one. It is a briefing, not a dashboard. The agent-facing instructions are in
[skills/cpa-brief/SKILL.md](../skills/cpa-brief/SKILL.md).

```
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h12m wk=81%~3d4h | haiku-5-5 opus-5-5 sonnet-5-5
codex low 1/2 5h=8%~22m wk=40%~2d | gpt-6-luna gpt-6-sol
guide: swarm=claude light=codex(5h=8%~22m)
```

## How it works

The command is the app binary itself: `cpa-gui --brief [--json] [--accounts] [--provider P] [--model M]`.
`main` handles `--brief` before the single-instance lock, GTK and the webview, so it starts fast,
never opens a window and works whether or not the app is running. When the app starts it writes a
tiny launcher that runs the current binary with `--brief`; the skill names the launcher, not the binary:

| OS | Launcher |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.cpa.gui/agent/cpa-brief` |
| macOS | `~/Library/Application Support/com.cpa.gui/agent/cpa-brief` |
| Windows | `%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd` |

The same folder holds two cache files, each written by one party only (so neither needs a lock):

| File | Written by | Contains | Refreshed |
| --- | --- | --- | --- |
| `quota.json` | the running app (`agent_briefing_publish`) | per account: provider, masked label, plan, 5h/weekly/other windows (remaining %, absolute reset time), balance, read time | when the app's quota cache changes (debounced) |
| `core.json` | the `--brief` command | per credential: provider, disabled, unavailable, retry time, cooldowns, model ids; whether the core answered | by a query, when older than 60 s (15 s after a failure) |

Both are `0600`, keyed by the core's management origin; a cache from another core is ignored.

## Data sources

- **Quota windows** come only from the app's existing quota cache (`src/services/quotaCache.ts`),
  which the Overview and Quota pages fill by asking the providers through the core. A small module
  (`src/sections/quota/agentBriefing.ts`) listens to that cache and sends a masked snapshot over one
  fenced command. It does no polling and makes no provider call of its own.
- **Availability and cooldowns** come from the core's `GET /v8/management/credentials`
  (disabled, unavailable, retry time, per-credential and per-model `cooldowns`).
- **Models** come from `GET /v8/management/credentials/models?name=` for each enabled credential,
  cached for 15 minutes per credential. A model is routable when an account that can route now serves it
  without a model cooldown; otherwise it is listed as `cool:` with the time the first serving account
  recovers. This is exact per credential, which `GET /v1/models` is not: that list has no provider and
  keeps quota-cooled models listed.
- The core's own quota `signals` (raw rate-limit response headers for Claude, Codex and Devin) are not
  used: they are provider-specific strings, present only after real traffic, with no stable window shape.

## Freshness

- Relative times ("resets in 1h12m") are computed when you run the command from absolute timestamps, so
  cached data never shows a wrong countdown. A window whose reset passed since the read prints `5h=reset`
  and counts as full.
- Every output states the age of the oldest quota read and flags it `stale` after 30 minutes.
- **Quota is only as fresh as the last time the app read it** (opening Overview or Quota, or a manual
  refresh). The command deliberately does not ask providers. With the app closed, the last read is served
  with its age.
- When the core cannot be reached the last core state is served and marked `core=down cached=<age>`.

## Privacy

Only masked labels (the same masking as privacy mode, applied before the data leaves the webview and
checked again in Rust), provider names, plans, percentages, times, model ids and a balance string are
stored or printed. No email, account id, file name, path, token or API key is written to the cache or
printed. The management key from the app's own config is used for the two core reads and never printed.
Rust tests assert this against a fixture that contains such values.

## Cost

- A query reads two small files. When `core.json` is older than the TTL it makes one `GET /credentials`
  (plus a model request per credential whose list is older than 15 minutes), bounded to 4 s each and
  32 model reads. Concurrent callers wait on a lock file and share one refresh.
- Nothing runs when nobody asks: there is no timer or listener in the app or the command. The only
  frontend work is one debounced IPC per quota cache change.
- A query never calls a provider and never starts or stops a core.

## Limits (not in this version)

Refreshing quota on demand while the app is idle; balances for API-key providers; usage history in the
briefing; any UI. In Remote mode the data comes from the remote core, and quota is cached per core address.
