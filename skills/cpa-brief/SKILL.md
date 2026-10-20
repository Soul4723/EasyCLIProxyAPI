---
name: cpa-brief
description: Get a cheap, cached briefing of how much quota headroom each provider/account has now, when its windows reset, and which models are routable or cooling down. Use BEFORE planning, delegating, fanning out sub-agents or choosing models/providers, and again before a long run. One command, about 150 tokens, no provider calls.
---

# cpa-brief: pre-delegation briefing

Run it, read it, then decide how hard to push. It answers: *who has headroom, when does it come back, which
models work right now*. It is a briefing, not a dashboard: run it once per plan, not in a loop.

## Run

| OS | Command |
| --- | --- |
| Linux | `"${XDG_DATA_HOME:-$HOME/.local/share}/com.cpa.gui/agent/cpa-brief"` |
| macOS | `"$HOME/Library/Application Support/com.cpa.gui/agent/cpa-brief"` |
| Windows | `"%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd"` |

The EasyCLIProxyAPI app writes that launcher each time it starts. Options: `--provider claude` · `--model opus`
(any part of a model id; lists every match) · `--accounts` (one line per account, masked) · `--json`.

## Read the output

```
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h11m wk=81%~3d3h | claude-fable-5-1 claude-haiku-5-5 claude-opus-5-5 claude-sonnet-5-5 +15
codex low 1/1 5h=8%~21m wk=40%~1d23h | codex-auto-review gpt-6-astra gpt-6-luna gpt-6.1-sol +9
guide: swarm=claude light=codex(5h=8%~21m)
```

- Header: `local|remote` core · `core=up|down|unknown` · `quota_age` = age of the oldest quota read (`stale` after 30m).
- Provider: `status usable/enabled`, then windows. `5h=62%~1h11m` = **62% left, resets in 1h11m**; `wk` weekly;
  `lim` another limit; `5h=reset` = it reset since the read (usage since is unknown, treat as full). Each window
  is the best usable account. `bal=` balance where known. `back=22m` = soonest recovery when nothing is usable.
  `quota=n/a` = usable, but no quota numbers for it.
- Status: `ok` · `low` (best account under 20% on its tightest window) · `out` all exhausted · `cool` all in a
  core cooldown · `err` auth failure, needs a human · `off` all disabled.
- After `|`: routable models, newest of each family, max 4 (`+15` more; image models hidden). `cool:m~4m` = no
  account can serve `m` for 4 more minutes. A model not listed is not offered by any enabled account.
- `guide:` is arithmetic on those numbers: `swarm` = best account at least 50% on every window · `light` = under
  50% or `low` (tightest window shown) · `wait` = unavailable but back within 30m · `avoid` = unavailable longer, or `err`.

## Turn it into a plan

- Several `swarm` providers: fan out in parallel, spread tasks across them, use the strongest models.
- Only `light`: 1-2 workers, serial, smaller models, short prompts, no speculative retries.
- A window is nearly out and `~` is minutes away (`wait`): do prep work now, start the heavy part after the reset.
  If it is hours or days away, move the work to another provider or a cheaper model instead.
- Size the fan-out by `usable` accounts and headroom, not by provider name.
- Before a run longer than the shortest `~`, run the command again.

Example 1: above output → send the big refactor to 3-4 claude workers (opus/sonnet); give codex one small
review, or hold it ~21m until `5h` resets.
Example 2: `claude out 0/2 back=3h` · `xai ok 1/1 | grok-4.7` · `guide: avoid=claude` → one serial worker on xai
now; do not queue claude-only work.

## Failure modes

- Launcher missing, or `no briefing data yet`: the app never ran on this machine. Ask the user to start
  EasyCLIProxyAPI and open Overview once. Do not invent numbers.
- `core=down cached=12m`: the core is stopped or unreachable. No models are listed and nothing routes; quota
  numbers are the last known ones.
- `stale` / large `quota_age`: quota is read only when the app's Overview or Quota page loads or the user
  refreshes it. Treat percentages as upper bounds; a recent heavy run may have used more.
- `quota=none`: the app has not read quota yet; only core state (cooldowns, disabled) is shown.
- `remote`: same data from the remote core; quota is cached per core address.
- Exit code 1 = no data, 2 = bad option. It never opens the app window and never calls a provider.
