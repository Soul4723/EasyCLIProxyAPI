---
name: cpa-brief
description: Get a cheap, cached briefing of provider headroom, reset times and routable models. Run BEFORE planning or delegating, and again before a long run. It sends no inference requests.
---

# cpa-brief: pre-delegation briefing

Run it before planning or delegating, and again before a long run. It reads cached quota and core
routing data, re-reads stale Claude, Codex and Devin quota from read-only usage endpoints, and never
sends an inference request; do not poll it.

## Run

| OS | Command |
| --- | --- |
| Linux | `"${XDG_DATA_HOME:-$HOME/.local/share}/com.cpa.gui/agent/cpa-brief"` |
| macOS | `"$HOME/Library/Application Support/com.cpa.gui/agent/cpa-brief"` |
| Windows PowerShell | `& "$env:APPDATA\com.cpa.gui\agent\cpa-brief.cmd"` |
| Windows cmd.exe | `"%APPDATA%\com.cpa.gui\agent\cpa-brief.cmd"` |

The app writes this launcher when it starts. Options: `--provider P`, `--model TEXT` (case-insensitive
substring; lists every match), `--accounts` (masked per-account lines), `--json`. Filter values may
contain only letters, digits and `. _ : / -`. `--skill` prints this file.

```text
cpa local core=up quota_age=6m
claude ok 2/2 5h=62%~1h11m wk=81%~3d2h | claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5-20251001 +5
codex low 1/1 5h=8%~20m wk=40%~1d23h | gpt-6.1-sol codex-auto-review cool:gpt-6-luna~3m
guide: swarm=claude light=codex(5h=8%~20m)
```

## Read it

- Header: `core=up` means core data is under 60 s old. `core=down cached=<age>`: the core is
  unreachable, nothing routes. `core=stale cached=<age>`: routing is unknown. `quota_age` is the oldest
  quota read shown; `stale` means over 30 minutes.
- Provider line: `status usable/enabled`, then the windows of its best account. `5h=62%~1h12m` means
  62% left, resets in 1h12m; `<1%` is nearly empty (under 0.5% counts as used up); `back=?` means used
  up with no known reset. `bal=` is a balance; `quota=n/a` means usable but no quota numbers.
- Status: `ok`, `low` (best account under 20% on its tightest window), `out` (used up), `cool`
  (cooling down), `err` (unavailable, no retry time), `off` (all disabled).
- After `|`: the newest routable model per family (up to four, no image models); `+N` more are
  routable, check with `--model`. `cool:m~4m` means no account can serve `m` for 4 more minutes.
- `guide:` `swarm` = at least 50% left on the tightest window; `light` = less; `wait` = unavailable,
  back within 30 minutes; `avoid` = unavailable longer or unknown. Providers without numbers are left out.

## Use it

- Fan heavy work out across `swarm` providers. With only `light` ones, use fewer workers and shorter
  prompts. For `wait`, prepare now and start heavy work after the reset; otherwise use another provider.
  Size fan-out by usable accounts and headroom, not by provider name. Do not route `cool:` models.
- The sample above: fan out on Claude; give Codex a small task or wait about 20 minutes; skip
  `gpt-6-luna` for now.
- `claude out 0/2 back=2h59m ...` with `guide: light=codex(5h=35%~20m) avoid=claude`: one serial worker
  on Codex, and nothing that only Claude can do until its reset.

## Failure modes

- Missing launcher, or `no briefing data yet` (exit 1): start EasyCLIProxyAPI with valid connection
  settings and open Overview or Quota once. Do not invent numbers. Exit 2 is a bad option.
- `core=down` although you know the core is up: your sandbox may block loopback; treat the numbers as
  unknown, not as an outage.
- While the core is up, Claude, Codex and Devin quota is at most about 5 minutes old; other providers
  are only as fresh as the app's last Overview/Quota load. `quota_age` shows the oldest read. `remote`
  means a remote core; quota is cached per core address.
