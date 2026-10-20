# Agent briefing

`cpa-brief` gives a coding agent a short, cached answer to: *how much quota headroom does each
provider have, when does it come back, and which models can I route to right now?* An agent runs it
before it plans or delegates, to choose between a wide parallel run and a slow, cheap one. The
agent-facing instructions are the skill in [skills/cpa-brief/SKILL.md](../skills/cpa-brief/SKILL.md);
`cpa-brief --skill` prints it, so you can install it wherever your agent client keeps skills.

```
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h11m wk=81%~3d2h | claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5-20251001 +5
codex low 1/1 5h=8%~20m wk=40%~1d23h | gpt-6.1-sol codex-auto-review cool:gpt-6-luna~3m
guide: swarm=claude light=codex(5h=8%~20m)
```

(Fictional fixture data.)

## How it works

The command is the app binary: `cpa-gui --brief [--json] [--accounts] [--provider P] [--model M] | --skill`.
`main` handles `--brief` before the single-instance lock, GTK and the webview, so it is fast, never
opens a window and works whether or not the app is running. Filter values may contain only ASCII
letters, digits and `. _ : / -`, because the Windows launcher's `%*` is re-parsed by `cmd`; anything
else, or an unknown option, exits 2.

When the app starts it writes a launcher that runs the current binary with `--brief`:

| OS | Launcher |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.cpa.gui/agent/cpa-brief` |
| macOS | `~/Library/Application Support/com.cpa.gui/agent/cpa-brief` |
| Windows | `%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd` |

The same folder holds two cache files, each written by one party only, both `0600` and keyed by the
core's management origin (a cache from another core is ignored):

| File | Written by | Contains | Refreshed |
| --- | --- | --- | --- |
| `quota.json` | the app (`agent_briefing_publish`) | per account: provider, masked label, plan, windows (remaining %, absolute reset time), balance, read time | when the app's quota cache changes (debounced 2 s, at most 15 s) |
| `core.json` | the command | per credential: provider, disabled, unavailable, retry time, cooldowns, model ids | by a query, when older than 60 s (15 s after a failure) |

The command reads the app's saved `config.toml` read-only to find the core and its management key. If
the app has never saved settings, or they cannot be read, it dials nothing, ignores the caches, prints
`no briefing data yet` and exits 1.

## Data sources

- **Quota windows** come only from the app's quota cache (`src/services/quotaCache.ts`), which the
  Overview and Quota pages fill. `src/sections/quota/agentBriefing.ts` listens to it and publishes a
  masked snapshot. It does not poll and makes no provider call.
- **Availability and cooldowns** come from the core's `GET /v8/management/credentials`.
- **Models** come from `GET /v8/management/credentials/models?name=` per enabled credential, cached 15
  minutes (at most 32 reads per refresh; failed reads are timestamped too, so later refreshes move on).
  Unlike `GET /v1/models`, this is exact per credential and reflects cooldowns. A model is routable when
  an account that can route now serves it without a model cooldown; otherwise it is listed as `cool:`
  until the first serving account recovers.
- The core's quota `signals` are not used: they are raw provider headers with no stable window shape.

## Freshness and guidance

- Relative times are computed when the command runs, from absolute timestamps. A window whose reset
  passed since the read prints `5h=reset` and counts as full.
- Quota is only as fresh as the app's last read (Overview, Quota or a manual refresh); the output
  states its age and flags it `stale` after 30 minutes. The command never asks providers.
- `core=up` means core data under 60 s old. An unreachable core prints `core=down cached=<age>`; any
  other failure or old data prints `core=stale cached=<age>`. Neither lists models.
- The guide is arithmetic with fixed thresholds in `render.rs`, on the unrounded percentage of the
  best usable account's tightest own window (displayed percentages are floored): at least 50% is
  `swarm`, less is `light`, under 20% makes the status `low`, under 0.5% makes a window used up
  (`out`). A provider with no usable account is `wait` if it recovers within 30 minutes, else `avoid`.

## Privacy

Only masked labels (privacy-mode masking, applied in the webview and checked again in Rust), provider
names, plans, percentages, times, model ids and a balance string are stored or printed. Records are
joined by `auth_index`, kept only when it is 1–64 ASCII letters, digits, `_` or `-` (core v8 sends a
truncated SHA-256); email-, filename- and JWT-shaped values are dropped. The management key is used for
the two core reads and never printed.

## Cost

A query reads two small files. When `core.json` is out of date it makes one `GET /credentials` plus
any due model reads, 4 s each, with a 25 s overall deadline. Concurrent callers share one refresh
through a lock file. Nothing runs when nobody asks: the app only has a one-shot publish debounce.

## Limits

Not in this version: refreshing quota while the app is idle, balances for API-key providers, usage
history and any UI. The skill is not installed into agent clients automatically.
