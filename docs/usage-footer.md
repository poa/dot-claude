# usage-footer: Claude Code mod

A Claude Code mod (plugin function hooks) that:

1. Draws a colored usage footer under the prompt box: model, effort, context bar, 5-hour limit, and a prompt-cache countdown.
2. Keeps the prompt cache warm while you are idle during work hours, so the next message doesn't have to process the whole conversation again.
3. Compacts an idle session after work hours (or after a few idle pings), just before the cache would expire, so a session left open overnight stays cheap to resume.

It comes with a status line script (`statusline-command.sh` in this repo) that shows `user@host:path`, the git branch, and a red warning when the cache lifetime isn't 1 hour.

- Mod: `mods/usage-footer/`, version 0.3.0
- Built on: Claude Code 2.1.296

---

## What you see

### Footer (under the prompt box, next to the mode indicator)

```
Opus 5.5 · xhigh · ▰▰▰▱▱▱▱▱▱▱ · 5h 30% · cache 42m · keep-alive ×2/3 →20:00
```

| Segment | Meaning | Colors |
|---|---|---|
| `Opus 5.5` | Current model | magenta, bold |
| `xhigh` | Effort of the last main-thread request. Before the first one, the configured level: `modelSettings.<model>.effortLevel`, else `effortLevel` | cyan |
| `▰▰▰▱▱▱▱▱▱▱` | Context window used, 10 cells | green < 50 %, yellow 50–79 %, red ≥ 80 % |
| `5h 30%` | 5-hour rate limit used | same thresholds |
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
usage-footer: turn: cache read 312k, written 2.0k, uncached 3, out 320; 5h 23.4% → 23.6%
```

- The figures are the request's tokens (read from the cache, written to it, uncached input, output) and the 5-hour meter before and after it, with one decimal; `?` where Claude Code had no reading yet. Off a subscription there's no meter part.
- The `turn:` line appears only with the `logUsage` option, once per turn of the main conversation.

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
- Only the main conversation is tracked; subagent requests are ignored.

---

## Does keep-alive save usage on Pro?

Anthropic doesn't publish how Pro and Max limits count cache reads, cache writes and uncached input, so the saving can't be computed from token counts alone. It can be measured: Claude Code receives the plan's 5-hour meter with each response, with one decimal, and the log lines show it before and after each ping, compaction and (with `logUsage`) turn.

1. Turn `logUsage` on in `/config`. Use a session with a large context (200k tokens or more). Close other sessions and claude.ai tabs: they share the meter. Don't change the model or effort during the test.
2. **Warm cost:** send `ok` three times, a few minutes apart. Each `turn:` line shows how far the meter moved for that many cache-read tokens.
3. **Cold cost:** switch `keepAlive` off, stay idle for more than an hour, then send `ok`, and `ok` once more right after. A response's meter reading may lag one request; the second line shows the rest.
4. **Ping cost:** switch `keepAlive` back on and stay idle for about an hour; read the ping's line. If its meter never moves while your turns move it, ping responses don't refresh the reading: take the change at your next message instead.
5. **Compare:** keep-alive saves usage when (pings per idle gap) × (ping cost) < (cold cost). At API price ratios (cache read 0.1×, 1-hour cache write 2× the input price) one cold rebuild costs about as much as 20 pings. If your measured ratio is under about 3, three idle pings no longer pay off: lower `maxIdlePings`.

The meter moves in steps of 0.1 %, so repeat each probe a few times. Switch `logUsage` off afterwards; it adds a line to every turn.

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
| `logUsage` | `false` | A log line per turn with its tokens and the 5-hour meter, for the measurement above. |

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
| `turn.start` / `turn.complete` | Tracks whether a turn is running; with `logUsage`, logs the turn's usage |
| `turn.step` | Records the request start time and effort |
| `session.compact` | Stops the countdown after a compaction you or Claude Code ran |
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
