---
name: cpa-brief
description: Get a cheap, cached briefing of provider headroom, reset times and routable models. Run BEFORE planning or delegating, and again before a long run. It makes no provider calls.
---

# cpa-brief: pre-delegation briefing

Run once before planning or delegation. It is a briefing, not a dashboard or a polling command.

## Run

| OS | Command |
| --- | --- |
| Linux | `"${XDG_DATA_HOME:-$HOME/.local/share}/com.cpa.gui/agent/cpa-brief"` |
| macOS | `"$HOME/Library/Application Support/com.cpa.gui/agent/cpa-brief"` |
| Windows PowerShell | `& "$env:APPDATA\com.cpa.gui\agent\cpa-brief.cmd"` |
| Windows cmd.exe | `"%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd"` |

The app writes the launcher at startup. Options: `--provider P`, `--model TEXT` (case-insensitive substring; lists every match), `--accounts` (masked per-account lines), `--json`.

## Read it

- Header: `local|remote|unknown`; `core=up` means core data was refreshed within 60 s. `core=down cached=<age>` means unreachable; `core=stale cached=<age>` means refresh failed for another reason. Old core data is never marked up. `quota_age` is the age of the oldest quota read among the displayed accounts; `stale` means over 30 min.
- Provider line: `status usable/enabled`, its windows, optional balance and models. Windows use the selected headroom account so the status, windows and guide agree. `5h=62%~1h12m` means 62% remains; reset in 1h12m. `<1%` is treated as exhausted. `back=?` means exhausted with no known reset.
- Status: `ok`, `low` (best account under 20% on its tightest window), `out`, `cool`, `err` (core says unavailable without a retry time), or `off` (all disabled). `quota=n/a` means usable but no quota numbers.
- After `|`, the default text samples up to four newest routable models, one per family, ordered by newest version; image models are omitted. `+N` means more models are routable. To check a specific model, run `--model <part>`. A model is unavailable only if `--model` does not list it or shows it under `cool:`.
- `cool:m~4m` means no account can serve `m` for 4 more minutes. `guide:` uses the same headroom: `swarm` = at least 50% on the tightest window; `light` = under 50% or `low`; `wait` = unavailable and back within 30 min; `avoid` = unavailable longer or reset unknown. Providers without quota numbers are omitted from the guide.

## Use it

- Several `swarm` providers: fan out across them. Only `light`: use fewer workers, serially, with shorter prompts. For `wait`, do prep now and start the heavy part after the reset if it is soon; otherwise use another provider.
- Size fan-out by usable accounts and headroom, not provider name. Run it again before a run longer than the shortest reset.

## Failure modes

- Missing launcher or `no briefing data yet`: start EasyCLIProxyAPI and open Overview or Quota once. Do not invent numbers.
- If you know the core is up but this command says `core=down`, your sandbox may block loopback; treat core-dependent numbers as unknown, not as an outage.
- `core=down` lists no models; `core=stale` says routing is unknown. A failed refresh never makes cached data live.
- `stale` quota is only refreshed when Overview or Quota loads or the user refreshes it. Treat it as potentially outdated; a recent run may have used more.
- `remote` uses the remote core. Quota is cached per core address. Exit 1 means no data; exit 2 means a bad option. The command does not open the app or call providers.
