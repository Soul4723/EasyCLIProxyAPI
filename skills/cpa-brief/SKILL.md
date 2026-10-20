---
name: cpa-brief
description: Get a cheap, cached briefing of provider headroom, reset times and routable models. Run BEFORE planning or delegating, and again before a long run. It makes no provider calls.
---

# cpa-brief: pre-delegation briefing

Run before planning or delegating, then again before a long run. It is a briefing, not a dashboard or polling command; it reads cached quota and routing data and makes no provider calls.

## Run

| OS | Command |
| --- | --- |
| Linux | `"${XDG_DATA_HOME:-$HOME/.local/share}/com.cpa.gui/agent/cpa-brief"` |
| macOS | `"$HOME/Library/Application Support/com.cpa.gui/agent/cpa-brief"` |
| Windows PowerShell | `& "$env:APPDATA\com.cpa.gui\agent\cpa-brief.cmd"` |
| Windows cmd.exe | `"%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd"` |

The app writes the launcher at startup. Options: `--provider P`, `--model TEXT` (case-insensitive substring; lists every match), `--accounts` (masked per-account lines), `--json`. Filter values must be plain words using only letters, digits, `-`, `.`, and `_` (the CLI also permits `:`, and `/`).

## Read it

- Header: `local|remote|unknown`; `core=up` means core data was refreshed within 60 s. `core=down cached=<age>` means unreachable; `core=stale cached=<age>` means refresh failed otherwise. Old core data is never marked up. `quota_age` is the oldest quota read among displayed accounts; `stale` means over 30 min.
- Provider line: `status usable/enabled`, windows, optional balance and models. Window figures come from the selected headroom account, so status and guide agree. `5h=62%~1h12m` means 62% remains and resets in 1h12m; `<1%` means exhausted. `back=?` means exhausted with no known reset.
- Status is `ok`, `low` (best account below 20% on its tightest window), `out`, `cool`, `err` (unavailable without retry time), or `off` (all disabled); `quota=n/a` means usable but no quota numbers.
- After `|`, default text samples up to four newest routable models, one per family, ordered by newest version; image models are omitted. `+N` means more non-image routable models. `cool:m~4m` means no account can serve `m` for 4 more minutes. Use `--model <part>` to check a specific model.
- `guide:` summarizes headroom: `swarm` = at least 50% on the tightest window; `light` = under 50% or `low`; `wait` = unavailable and back within 30 min; `avoid` = unavailable longer or reset unknown. Providers without quota numbers are omitted.

```text
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h11m wk=81%~3d2h | claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5-20251001 +5
codex low 1/1 5h=8%~20m wk=40%~1d23h | gpt-6.1-sol codex-auto-review cool:gpt-6-luna~3m
guide: swarm=claude light=codex(5h=8%~20m)
```

## Use it

- Several `swarm` providers: fan out across them. If only `light` providers remain, use fewer workers and shorter prompts. For `wait`, prep now and start heavy work after a soon reset; otherwise use another provider. Size fan-out by usable accounts and headroom, not provider name.
- Example: the sample above → fan out heavy work to Claude; give Codex a small task or wait about 20 minutes for its 5h reset. Do not route `gpt-6-luna` until its model cooldown clears.
- Tight case, captured from the binary:

  ```text
  cpa local core=up quota_age=6m
  claude out 0/2 back=2h59m 5h=<1%~2h59m wk=81%~3d2h
  codex ok 1/1 5h=35%~20m wk=40%~1d23h | gpt-6.1-sol codex-auto-review cool:gpt-6-luna~3m
  guide: light=codex(5h=35%~20m) avoid=claude
  ```

  Output → decision: use one serial worker on Codex and smaller models; do no work that only Claude can do until its reset. Also skip `gpt-6-luna` until its cooldown clears.

## Failure modes

- Missing launcher or `no briefing data yet`: restore valid saved connection settings, then start EasyCLIProxyAPI and open Overview or Quota once. Do not invent numbers.
- If you know the core is up but the command says `core=down`, the sandbox may block loopback; treat core-dependent numbers as unknown, not an outage. `core=down` lists no models; `core=stale` means routing is unknown.
- Stale quota is only refreshed when Overview or Quota loads or the user refreshes it. Treat it as potentially outdated; a recent run may have used more. `remote` uses the remote core; quota is cached per core address. Exit 1 means no data; exit 2 means a bad option.
