# usage-footer: Claude Code mod

A Claude Code mod (plugin function hooks) that:

1. Draws a colored usage footer under the prompt box: model, effort, context bar, 5-hour and 7-day limits, and a prompt-cache countdown.
2. Keeps the prompt cache warm while you are idle during work hours, so the next message doesn't have to process the whole conversation again.
3. Compacts an idle session after work hours (or after a few idle pings), just before the cache would expire, so a session left open overnight stays cheap to resume.

It comes with a status line script (`statusline-command.sh` in this repo) that shows `user@host:path`, the git branch, and a red warning when the cache lifetime isn't 1 hour.

- Mod: `mods/usage-footer/`, version 0.4.0
- Built on: Claude Code 2.1.296

---

## What you see

### Footer (under the prompt box, next to the mode indicator)

```
Opus 5.5 · xhigh · ▰▰▰▱▱▱▱▱▱▱ · 5h 30% · 7d 12% · cache 42m · keep-alive ×2/3 →20:00
```

| Segment | Meaning | Colors |
|---|---|---|
| `Opus 5.5` | Current model | magenta, bold |
| `xhigh` | Effort of the last main-thread request. Before the first one, the configured level: `modelSettings.<model>.effortLevel`, else `effortLevel` | cyan |
| `▰▰▰▱▱▱▱▱▱▱` | Context window used, 10 cells | green < 50 %, yellow 50–79 %, red ≥ 80 % |
| `5h 30%` | 5-hour rate limit used (`showFiveHour`) | same thresholds |
| `7d 12%` | 7-day rate limit used (`showWeek`) | same thresholds |
| `cache 42m` | Minutes left on the prompt cache, counted from the **start** of the last request (that's how the API counts it) | green > 15 m, yellow ≤ 15 m, red `cache cold` |
| keep-alive note | What the keep-alive will do next (see below) | dim, or yellow when paused |

Keep-alive notes:

- `keep-alive →20:00`: work hours; pings will keep the cache warm until 20:00.
- `keep-alive ×2/3 →20:00`: two of at most three pings sent since your last message (`maxIdlePings`; with no limit, just `×2`).
- `compact on expiry`: after work hours, on a day off, or after the last allowed ping; the session will be compacted when the cache is about to expire.
- `keep-alive paused: cache was cold` (yellow): a ping found the cache already expired. Pings stop until your next message (see "5-minute cache" below).
- `keep-alive paused: pings failed` (yellow): three pings in a row failed (an overloaded API, a rate limit). Pings stop until your next message.
- Nothing: already compacted and no new message since; or the context is under `minCompactTokens`; or a compaction found the cache cold earlier in this session.

### Transcript log lines

Each action writes one dim line, so you can see what happened while you were away:

```
usage-footer: keep-alive ping at 14:55: cache read 312k, written 0, uncached 12, out 5; 5h 23.4% → 23.5%
usage-footer: keep-alive ping at 14:55 failed (<reason>)
usage-footer: keep-alive ping at 14:56 failed (<reason>), 3 in a row; keep-alive is paused until your next message
usage-footer: keep-alive ping at 14:55 found the cache already cold (...); ... keep-alive is paused until your next message
usage-footer: keep-alive at 14:55: nothing to keep warm since /clear
usage-footer: compacted at 15:40, idle after 3 pings (cache read 312k, written 2.0k, uncached 9, out 4.1k; 5h 40.1% → 41.0%)
usage-footer: compacted at 20:37, idle outside work hours (...)
usage-footer: compacted at 20:37, idle outside work hours, but the cache was cold (...); no more automatic compactions in this session
usage-footer: compaction at 20:37 skipped (<reason>)
```

- The figures are the request's tokens (read from the cache, written to it, uncached input, output) and the 5-hour meter before and after it, with one decimal; `?` where Claude Code had no reading yet. Off a subscription there's no meter part.

### Usage log (`logUsage`)

With `logUsage` on, the mod appends one JSON line per model request (main conversation and subagents), keep-alive ping and compaction to `~/.claude/logs/usage/<date>-<session id>.jsonl` (under `$CLAUDE_CONFIG_DIR` if that's set). Each line has when the request started, its model and tokens, and the 5-hour and 7-day meters after it with their reset times; no prompt or reply text. `claude-keepalive-report.sh` reads it: see "Does keep-alive save usage on Pro?" below.

```
{"kind":"request","t":1792044000000,"agent":false,"model":"claude-opus-5-5","read":312000,"write":2000,"input":3,"output":320,"h5":23.6,"h5Reset":"2026-10-19T08:00:00Z","d7":41,"d7Reset":"2026-10-23T00:00:00Z","session":"…"}
```

Pings add `outcome`; compactions add `trigger` (`keepalive` for the mod's own, `manual`, `auto` or `precompute`) and `tokensBefore`/`tokensAfter` when Claude Code reports them.

### Status line (`statusline-command.sh`)

```
user@host:/h/u/s/my-project    main ✓ cache 5m
```

- `user@host:path`, colored like the bash `PS1` prompt.
- When the line is too wide, leading path parts are cut to their first letter (p10k style); the last part is kept whole.
- Git segment in the oh-my-bash powerbash10k style: Nerd Font icons, branch, then a green `✓` (clean) or red `✗` (uncommitted changes).
- A red `cache 5m` (or any value other than `1h`) when Claude Code reports a short cache lifetime. Normally it doesn't show at all.

---

## Why keep the cache warm

Each request re-sends the whole conversation. If the prompt cache is warm, that history is read at a small fraction of the input price. If it's cold, the whole history is processed again at full price and written back into the cache.

Example for a 300–400K-token session on Opus 5.5, at API list prices. A subscription isn't billed per token, so read it for the ratio only:

| Next message after a pause | Approximate input cost at API prices |
|---|---|
| Cache warm | $0.07–0.10 |
| Cache cold | $2.40–3.20 |

On a subscription the cache lives 1 hour from the start of the last request, and what counts is the plan's usage meter. Anthropic doesn't publish how the meter weighs cache reads against cache writes; "Does keep-alive save usage on Pro?" below shows how to measure it.

**Compaction isn't local.** Claude writes the summary in an API request that carries the whole conversation; Claude Code only swaps the history for the summary afterwards. Claude Code runs that request as a fork of the main conversation, so it's meant to read the conversation's cache: compacting while the cache is warm is cheap, and compacting a cold session costs the full rebuild. That's why the mod compacts only while the cache is still warm. It also checks: each compaction's log line shows its cache read and written tokens, and if a compaction had to write most of the conversation again, the mod stops automatic compactions for the rest of that session.

---

## How the keep-alive works

Every 30 seconds the mod redraws the footer and decides what to do:

| Situation | Action |
|---|---|
| Keep-alive switched off, a turn is running, or paused (a cold ping, or 3 failed pings) | nothing |
| No request yet in this session, or none since `/clear` or a compaction | nothing |
| More than 5 min of cache left (half the lifetime when `cacheTtlMinutes` is under 10) | nothing |
| Cache already expired | nothing (no point paying for a rebuild while you're away) |
| ≤ 5 min left, **inside** work hours on a work day (Mon–Fri 07:00–20:00), fewer than 3 pings since your last message | **ping** |
| ≤ 5 min left, after the last allowed ping, after work hours or on a day off, and you've typed something since the last compaction | **compact** (same as `/compact`) |
| Same, but the context is under 50k tokens, or a compaction already found the cache cold in this session | nothing; the cache expires |
| ≤ 5 min left, already compacted and nothing typed since | nothing |

### Ping

- The mod re-sends the main conversation's last request plus one short line, "Keep-alive ping ... Reply with the single word: ok", using `$.model.fork`.
- That reads the cached history and restarts its 1-hour timer.
- Nothing is added to your transcript; only the log line shows.
- A ping is judged by what it was billed, not by its reply: an empty reply still refreshed the cache.
- A ping that billed nothing (an overloaded API, a rate limit) failed: the countdown is restored and the next tick (30 s later) retries. After 3 failures in a row, keep-alive pauses until your next message.
- If a turn of yours starts while a ping is on its way, the turn's request time wins.

### Idle limit

- At most 3 pings in a row without a message from you (`maxIdlePings`). At the next near-expiry the session is compacted instead, while the cache is still warm.
- So a session left idle for hours costs at most 3 pings and one compaction, and your next message rebuilds only the summary. `0` removes the limit.

### Evening compaction

- After work hours, or on a day off, compaction happens once, when the cache has ≤ 5 min left, not at 20:00 sharp.
- It's skipped when the context is under `minCompactTokens` (50k): rebuilding a small context costs less than a summary request.
- After that the session stays quiet: no pings, no further compactions.
- A skipped or failed compaction isn't retried until you type again.
- A `/compact` of your own (or an automatic one) also stops the countdown: the compacted conversation has no cache yet, so there's nothing to ping.

### Next morning

The cache will have expired overnight. Your first message rebuilds it (once, on the small compacted history), and pings resume until the end of work hours.

### Your own messages

Any message you type (or send from a remote client) resets the ping and failure counters and clears the "paused" state.

### 5-minute cache: the safety check

Claude Code uses the 1-hour cache on a subscription within its usage limits. It falls back to the **5-minute** cache in these cases:

- with an API key, Bedrock, Vertex or Foundry;
- during usage overage.

With a 5-minute cache, pings 55 minutes apart can't keep anything warm; each one would just pay for a rebuild. Two safeguards handle this:

1. **Status line:** a red `cache 5m` tells you up front.
2. **Self-check:** after each ping the mod compares the tokens read from the cache with the rest of the input.
    - If less than half came from the cache (it was written again, or prompt caching is off), the cache was cold.
    - The mod then pauses keep-alive and the evening compaction, shows the yellow `keep-alive paused: cache was cold`, and writes a log line.
    - Your next message clears the pause.

### Limits

- The mod only runs while Claude Code is open. If you close the terminal or the PC (or WSL) sleeps, nothing pings and the cache expires as usual.
- Each open session keeps its own cache warm, and each one costs pings. Close sessions you're done with.
- Only the main conversation is kept warm; subagent requests are ignored (the usage log still records them).

---

## Does keep-alive save usage on Pro?

Anthropic doesn't publish how Pro and Max limits count cache reads, cache writes and output, so the saving can't be computed from token counts alone. It can be measured: Claude Code receives the plan's 5-hour and 7-day meters with each response, with one decimal, and the usage log puts them next to each request's tokens.

Comparing a week with keep-alive against a week without wouldn't show it. Keep-alive only matters for idle gaps of 1–3 hours, a handful a week, and one avoided rebuild of a 150k context is worth a few percent of a week's usage; in this setup's own history daily usage varied more than tenfold and two weeks in a row differed by half. So the report weighs each gap on its own instead: what its pings cost, against the rebuild they avoided. That needs only a period with keep-alive on.

1. Turn `logUsage` on in `/config`, leave keep-alive on, and work as usual for a week or more.
2. Run `claude-keepalive-report.sh` (in this repo's `bin/`, on `PATH`). It fits what the meters charge per read, written and output token, then adds up the pings against the rebuilds they avoided, one `name<TAB>value` row per figure:
    - `write_read_ratio`: how many read tokens a written one costs on your plan. At API prices it's 20: one rebuild costs as much as 20 pings.
    - `rebuilds_avoided`: you came back to a warm cache after more than its lifetime. `chains_wasted`: you came back after it expired anyway, or the session was compacted first.
    - `ping_net_5h` and `ping_net_7d`: the rebuilds avoided minus all pings, in % of each meter; above 0 keep-alive saves usage. `ping_net_share`: the same as a share of the period's 5-hour use.
    - `compaction_cost` and `compaction_saving`: the mod's compactions, against rebuilding the full history at the next request. The smaller history of later requests isn't counted.
3. Run `claude-keepalive-report.sh -w`. It replays the gaps in your transcripts with the fitted weights, one row per `maxIdlePings` value from 0 to 6: the gaps pinged, pings, rebuilds avoided and the net. Set `maxIdlePings` to the best one; if every net is below 0, switch keep-alive off. It also works before there's a log, in API price units.

`fit` says `weights` once the log has 10 hourly windows with meter readings, else `api-ratios` (API price ratios scaled to the meter). Other use of the same account (claude.ai, another computer) moves the meters too and blurs the fit, and Claude Code's own background requests aren't logged. Switch `logUsage` off when you're done; the log takes about 300 bytes per request.

### Reading the report

On a terminal the columns are aligned; piped, they are tab-separated. Money rows end in `_5h` and `_7d`: percent of that meter. While the log has no meter readings they end in `_keq` instead: thousands of input tokens at API prices, for comparing rows with each other only. Every row ending in `_7d` is missing when the log has no 7-day readings.

Without `-w` (the ledger of what really happened, from the usage log):

| Row | Meaning | How to read it |
|---|---|---|
| `fit` | `weights`: the meter's price per token was fitted on your data. `api-ratios`: too little data, API price ratios were scaled to the meter. `none`: no meter readings at all | Trust the money rows most under `weights`. Under `api-ratios` they are estimates |
| `fit_windows_5h`, `fit_windows_7d` | Hourly windows the fit used | The weights need at least 10 windows. More is better |
| `read_per_M_*`, `written_per_M_*`, `output_per_M_*` | What a million read, newly cached and output tokens move the meter | The three prices the rest is computed from |
| `write_read_ratio` | `written_per_M` divided by `read_per_M` | API price says 20. `-` means the fit can't tell the read price from zero (it is not above twice its standard error), so the ratio would be noise; reads then cost very little, and the pings look nearly free. Read it together with `fit`: under `api-ratios` it is the assumed 20 |
| `requests`, `agent_requests` | Main-conversation and subagent requests in the log | Only the main ones are weighed |
| `pings`, `pings_failed` | Keep-alive pings sent, and those that billed nothing | Failed pings cost nothing and are not counted in `pings` |
| `rebuilds_avoided` | Pinged gaps where you came back to a warm cache after the cache lifetime | These are the wins: each one paid a read instead of a rebuild |
| `chains_wasted` | Pinged gaps that ended with a cold cache anyway, or a compaction in between | Pings that bought nothing |
| `pings_unneeded` | Pinged gaps shorter than the cache lifetime | Pings you didn't need |
| `chains_open` | Pings sent for a session that hasn't had a message since | Not yet a win or a loss |
| `cold_starts` | Returns after a long gap, to a cold cache, with no pings | What keep-alive was off for or didn't cover |
| `keepalive_compactions` | Evening compactions the mod ran | See the two compaction rows below |
| `used_*` | All usage in the log, in the unit of the fit | The base for `ping_net_share` |
| `ping_cost_*`, `rebuild_saving_*` | What the pings cost, and what the avoided rebuilds would have cost | `ping_net` is their difference |
| `ping_net_*` | `rebuild_saving` minus `ping_cost` | Above 0: keep-alive saved usage. Below 0: it cost more than it saved |
| `ping_net_share` | `ping_net_5h` as a share of `used_5h` | The saving as a share of the period's use. A few percent is normal |
| `compaction_cost_*`, `compaction_saving_*` | The evening compactions, against rebuilding the whole history at your next request | Saving above cost: compaction paid off. It ignores the smaller history of later requests |

A sample: `rebuilds_avoided 13`, `ping_cost_5h 4.46`, `rebuild_saving_5h 38.62`, `ping_net_5h 34.16`, `ping_net_share 5.2%`. The 37 pings cost 4.5% of the 5-hour meter, the 13 avoided rebuilds would have cost 38.6%, so keep-alive saved 34.2%, which is 5.2% of everything used. If `write_read_ratio` is `-`, take the size of the saving as an upper bound: with API-like prices it can be several times smaller, but the sign and the best `maxIdlePings` don't change.

With `-w` (a what-if replay, not what happened):

- It replays the gaps between requests in `~/.claude/projects` transcripts, for the work hours and days you set (`--from`, `--until`, `--days`, `--utc-offset`; defaults 07:00-20:00, Mon-Fri), and the cache lifetime and lead (`--ttl`, `--lead`). It doesn't need the usage log. Without one it uses API prices.
- Stderr says the unit of `net` and what the weights came from. On a terminal there is a header row; piped there isn't.
- One row per `maxIdlePings` limit, 0 to 6. Limit 0 is keep-alive off, all zeros: the baseline.

| Column | Meaning |
|---|---|
| `limit` | The `maxIdlePings` value replayed |
| `gaps pinged` | Gaps between two requests of a session in which at least one ping would go out (inside work hours, before the next request) |
| `pings` | Pings sent in all those gaps |
| `rebuilds avoided` | Gaps where the pings kept the cache alive until your next request, so that request found it warm |
| `net` | Rebuilds avoided minus pings, in % of the 5-hour meter |

Pick the limit where `net` stops rising. In this sample the net is 57.54, 68.09, 74.24, 77.85, 79.08, 79.08 for limits 1 to 6: it flattens at 5, and 6 sends one ping more for nothing, so set `maxIdlePings` to 5. If every `net` is below 0, switch keep-alive off. It ignores compactions and the meter's other users, so treat small differences between neighbouring limits as noise.

---

## Options

Change them in `/config` (the usage-footer rows). They're stored in `~/.claude/settings.json` under `pluginConfigs`, and a change reloads the mod.

| Option | Default | Meaning |
|---|---|---|
| `keepAlive` | `true` | Master switch for pings and compaction. The footer stays either way. |
| `keepAliveFrom` | `07:00` | Work hours start (local time). |
| `keepAliveUntil` | `20:00` | Work hours end. After this an idle session is compacted instead of kept warm. A window across midnight (e.g. `22:00`–`06:00`) is allowed, and its hours after midnight belong to the day it started. Equal to `keepAliveFrom`: no work hours at all, so the mod never pings and only compacts. |
| `keepAliveDays` | `Mon-Fri` | Days with work hours: ranges and lists such as `Mon-Fri`, `Mon,Wed,Fri` or `Mon-Sun`. Other days are treated as after hours. |
| `maxIdlePings` | `3` | Pings in a row without a message from you; the next near-expiry compacts instead. `0` = no limit. |
| `minCompactTokens` | `50000` | Smaller contexts aren't compacted; they're left to expire. |
| `utcOffset` | empty | Empty means the system timezone. Set it (e.g. `+07:00`, from `-12:00` to `+14:00`) if work hours look shifted. |
| `cacheTtlMinutes` | `60` | Assumed cache lifetime, 2–60. Keep 60; lower it only for a quick test. |
| `showFiveHour` | `true` | Show the `5h` segment. |
| `showWeek` | `true` | Show the `7d` segment. |
| `logUsage` | `false` | Writes each request, ping and compaction with its tokens and both meters to `~/.claude/logs/usage/`, for `claude-keepalive-report.sh` (see "Usage log"). |

### Quick live test

1. In `/config`, set `cacheTtlMinutes` to `7`, `keepAliveUntil` to about 15 minutes from now, and `minCompactTokens` to `0` (a test session is usually smaller than 50k tokens).
2. Send a message, then stay idle.
3. About 3.5 minutes after the request started (half the lifetime), expect `usage-footer: keep-alive ping at HH:MM: ...` and the countdown restarting.
4. After the cutoff, on the next near-expiry, expect `usage-footer: compacted at HH:MM, idle outside work hours`.
5. Set the options back to `60`, `20:00` and `50000`.

---

## Install / copy to another computer

The mod and the status line script are part of the `dot-claude` repo: follow "New machine" in [`README.md`](../README.md#new-machine).

### Requirements

- Claude Code with mods support (built on **2.1.296**; check with `claude --version`).
- `bash`, `jq` and `git` for the status line script.
- A Nerd Font in the terminal, for the git icons.

The `claude` shell function (`shell/claude.sh`) sets `CLAUDE_CODE_PLUGIN_DIRS` to `$CLAUDE_SETUP_DIR/mods`. Claude Code treats that as a folder of plugins and loads every mod in it, so another mod only needs its own folder there. Claude Code also reads the variable from user settings or `--settings`, never from a project's settings.

### Verify and restart

```bash
claude plugin validate mods/usage-footer   # one "no author" warning is expected
claude plugin test mods/usage-footer       # all tests should pass
```

Restart Claude Code through the `claude` shell function. The footer appears under the prompt box after the first redraw.

Options you changed in `/config` live in each machine's own settings; set them again on a new machine.

### Switch it off

- Pings and compaction only: set `keepAlive` to off in `/config`.
- The whole mod: move `mods/usage-footer/` out of `mods/` and restart.
- Status line: remove the `statusLine` block from `settings.json` in this repo.

---

## Files

```
statusline-command.sh                    status line script
bin/claude-keepalive-report.sh           weighs the keep-alive's cost against its saving (logUsage)
mods/usage-footer/
├── .claude-plugin/plugin.json           manifest + userConfig options
├── hooks/hooks.json                     points at register.tsx
├── hooks/register.tsx                   hooks: footer, timers, ping/compact, log lines
├── hooks/keepalive.ts                   pure logic: decide(), plan(), ping outcome, time and day helpers
├── hooks/register.test.ts               footer, log line and keep-alive tests
├── hooks/keepalive.test.ts              decision and time helper tests
├── types/index.d.ts                     $.state contract (session values)
└── tsconfig.json                        extends the generated .claude-plugin/types/tsconfig.json
```

Hooks used:

| Hook | What the mod does there |
|---|---|
| `session.start` | Starts the 30 s timer |
| `prompt.submit` | Notices your own messages |
| `turn.start` / `turn.complete` | Tracks whether a turn is running |
| `turn.step` | Records the request start time and effort; with `logUsage`, logs each request, subagents' too |
| `session.compact` | Stops the countdown after a compaction you or Claude Code ran; with `logUsage`, logs it |
| `ui.render` (`SessionMode`) | Draws the footer |

Session values live in `$.state`, so they survive a hot reload of the mod.

## Development

- Editing files in `mods/usage-footer/` reloads the mod in running sessions; the folder is watched.
- Checks:
  ```bash
  claude plugin validate mods/usage-footer
  claude plugin test mods/usage-footer
  tsc -p mods/usage-footer   # after the mod has loaded once (needs the generated types)
  ```
- Hook failures show as a dim `usage-footer: ...` line in the transcript. Run `claude --debug` for the full log.
