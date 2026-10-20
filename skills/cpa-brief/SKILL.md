---
name: cpa-brief
description: Get a cheap, cached briefing of how much quota headroom each provider/account has now, when windows reset, and which models are routable or cooling down. Use BEFORE planning, delegating, fanning out sub-agents or choosing models/providers, and again before a long run. One command, ~100 tokens, no provider calls.
---

# cpa-brief: pre-delegation briefing

Run it, read it, then choose how hard to push. It answers: *who has headroom, when does it come back, which
models work right now*. It is not a dashboard; call it before each plan, not in a loop.

## Run

| OS | Command |
| --- | --- |
| Linux | `"${XDG_DATA_HOME:-$HOME/.local/share}/com.cpa.gui/agent/cpa-brief"` |
| macOS | `"$HOME/Library/Application Support/com.cpa.gui/agent/cpa-brief"` |
| Windows | `"%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd"` |

Options: `--provider claude` · `--model opus` (substring of a model id) · `--accounts` (one line per account,
masked ids) · `--json`. Default output is enough for planning.

## Read the output

```
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h12m wk=81%~3d4h | haiku-5-5 opus-5-5 sonnet-5-5
codex low 1/2 5h=8%~22m wk=40%~2d | gpt-6-luna gpt-6-sol cool:gpt-6-astra~4m
xai ok 1/1 bal=$12.40 | grok-4.7
guide: swarm=claude,xai light=codex(5h=8%~22m)
```

- Header: `local|remote` core; `core=up|down|unknown`; `quota_age` = age of the oldest quota read (`stale` after 30m).
- Provider line: `status usable/enabled`, then per window `5h=62%~1h12m` = **62% left, resets in 1h12m**.
  `wk` = weekly; `lim` = another limit; `5h=reset` = it reset since the read, usage since is unknown (treat as full).
  Each window shows the best usable account. `bal=` balance (only where known). `back=22m` = soonest recovery
  when nothing is usable. `quota=n/a` = usable but no quota data (not all providers report it).
- Status: `ok` plenty · `low` best account under 20% on its tightest window · `out` every account exhausted ·
  `cool` every account in a core cooldown · `err` auth failure, needs a human · `off` all disabled.
- After `|`: models routable now (first 6; `--model X` lists all matches). `cool:m~4m` = no account can serve `m`
  until then. A model that is missing is not offered by any enabled account.
- `guide:` is arithmetic on the numbers: `swarm` = best account ≥ 50% on every window; `light` = under 50% or
  `low` (tightest window shown); `wait` = unavailable but back within 30m; `avoid` = unavailable longer, or `err`.

## Turn it into a plan

- Many `swarm` providers: fan out in parallel, spread tasks across them, use the strongest models.
- Only `light`: run serially or with 1-2 workers, prefer smaller models, keep prompts short, avoid retries.
- A window is nearly out and `~` is minutes away (say under 30m): do prep work, then start after the reset.
  If `~` is hours or days away, move work to another provider or a cheaper model instead.
- Plan fan-out width from `usable` accounts × headroom, not from the provider name alone.
- Before a run longer than the shortest `~`, re-run the command to confirm.

Example 1: `claude ok 2/2 5h=62%~1h12m wk=81%`, `codex low 5h=8%~22m` → send the heavy refactor to 3-4 claude
workers; give codex only a small review, or hold it 22m.
Example 2: `claude out 0/2 back=3h`, `xai ok 1/1 | grok-4.7`, no other provider → one serial worker on xai;
do not queue claude-only work now.

## Failure modes

- `no briefing data yet` or file not found: the app never ran on this machine. Ask the user to start
  EasyCLIProxyAPI and open Overview once; do not invent numbers.
- `core=down cached=12m`: the core is stopped or unreachable; numbers are the last known ones. Cooldown times
  are absolute, so they still count down. Don't assume models are routable.
- `stale` / large `quota_age`: quota is only refreshed when the app's Overview or Quota page loads or the user
  refreshes it. Treat percentages as upper bounds; a recent heavy run may have used more.
- `quota=none`: the app has not read quota yet. Only core state (cooling, disabled) is shown.
- `remote` mode: same data from the remote core; quota is cached per core address.
- Exit code 1 = no data, 2 = bad option. The command never starts the app window and never calls a provider.
