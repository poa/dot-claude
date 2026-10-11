# usage-footer: Claude Code mod

A Claude Code mod (plugin function hooks) that:

1. Draws a colored usage footer under the prompt box: model, effort, context bar, 5-hour limit, and a prompt-cache countdown.
2. Keeps the prompt cache warm while you are idle during work hours, so the next message doesn't have to process the whole conversation again.
3. Compacts an idle session after work hours, just before the cache would expire, so a session left open overnight stays cheap to resume.

It comes with a status line script (`statusline-command.sh` in this repo) that shows `user@host:path`, the git branch, and a red warning when the cache lifetime isn't 1 hour.

- Mod: `mods/usage-footer/`, version 0.2.0
- Built on: Claude Code 2.1.289

---

## What you see

### Footer (under the prompt box, next to the mode indicator)

```
Opus 5.5 · xhigh · ▰▰▰▱▱▱▱▱▱▱ · 5h 30% · cache 42m · keep-alive ×2 →20:00
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
- `keep-alive ×2 →20:00`: two pings sent since your last message.
- `compact on expiry`: after work hours; the session will be compacted when the cache is about to expire.
- `keep-alive paused: cache was cold` (yellow): a ping found the cache already expired. Pings stop until your next message (see "5-minute cache" below).
- Nothing: after work hours, already compacted, and no new message since.

### Transcript log lines

Each action writes one dim line, so you can see what happened while you were away:

```
usage-footer: keep-alive ping at 14:55
usage-footer: keep-alive ping at 14:55 failed (<reason>)
usage-footer: keep-alive ping at 14:55 found the cache already cold; ... keep-alive is paused until your next message
usage-footer: compacted at 20:37, idle outside work hours
usage-footer: compaction at 20:37 skipped (<reason>)
```

### Status line (`statusline-command.sh`)

```
user@host:/h/u/s/my-project    main ✓ cache 5m
```

- `user@host:path`, colored like the bash `PS1` prompt.
- When the line is too wide, leading path parts are cut to their first letter (p10k style); the last part is kept whole.
- Git segment in the oh-my-bash powerbash10k style: Nerd Font icons, branch, then a green `✓` (clean) or red `✗` (uncommitted changes).
- A red `cache 5m` (or any value other than `1h`) when Claude Code reports a short cache lifetime. Normally it doesn't show at all.

---

## Why keep the cache warm

Each request re-sends the whole conversation. If the prompt cache is warm, that history is read at a small fraction of the input price. If it's cold, the whole history is processed again at full price and written back into the cache.

Example for a 300–400K-token session on Opus 5.5:

| Next message after a pause | Approximate input cost |
|---|---|
| Cache warm | $0.07–0.10 |
| Cache cold | $2.40–3.20 |

On a subscription the cache lives 1 hour from the start of the last request. A keep-alive ping costs about one warm read, which is far cheaper than a cold rebuild.

**Compaction isn't local.** Claude writes the summary in an API request that carries the whole conversation; Claude Code only swaps the history for the summary afterwards. Compaction shares the main conversation's cache, so compacting while the cache is warm is cheap and compacting a cold session costs the full rebuild. That's why the mod compacts only while the cache is still warm.

---

## How the keep-alive works

Every 30 seconds the mod redraws the footer and decides what to do:

| Situation | Action |
|---|---|
| Keep-alive switched off, a turn is running, or paused after a cold ping | nothing |
| No request yet in this session | nothing |
| More than 5 min of cache left | nothing |
| Cache already expired | nothing (no point paying for a rebuild while you're away) |
| ≤ 5 min left, **inside** work hours (07:00–20:00) | **ping** |
| ≤ 5 min left, **outside** work hours, you've typed something since the last compaction | **compact** (same as `/compact`) |
| ≤ 5 min left, outside work hours, already compacted and nothing typed since | nothing |

### Ping

- The mod re-sends the main conversation's last request plus one short line, "Keep-alive ping ... Reply with the single word: ok", using `$.model.fork`.
- That reads the cached history and restarts its 1-hour timer.
- Nothing is added to your transcript; only the log line shows.
- If the ping fails, the countdown is restored and the next tick (30 s later) retries while the cache is still warm.

### Evening compaction

- After work hours, compaction happens once, when the cache has ≤ 5 min left, not at 20:00 sharp.
- After that the session stays quiet: no pings, no further compactions.
- A skipped or failed compaction isn't retried until you type again.

### Next morning

The cache will have expired overnight. Your first message rebuilds it (once, on the small compacted history), and pings resume until the end of work hours.

### Your own messages

Any message you type (or send from a remote client) resets the ping counter and clears the "paused" state.

### 5-minute cache: the safety check

Claude Code uses the 1-hour cache on a subscription within its usage limits. It falls back to the **5-minute** cache in these cases:

- with an API key, Bedrock, Vertex or Foundry;
- during usage overage.

With a 5-minute cache, pings 55 minutes apart can't keep anything warm; each one would just pay for a rebuild. Two safeguards handle this:

1. **Status line:** a red `cache 5m` tells you up front.
2. **Self-check:** after each ping the mod compares cache-read tokens with cache-write tokens.
   - If most of the history had to be written again, the cache was already cold.
   - The mod then pauses keep-alive and the evening compaction, shows the yellow `keep-alive paused: cache was cold`, and writes a log line.
   - Your next message clears the pause.

### Limits

- The mod only runs while Claude Code is open. If you close the terminal or the PC (or WSL) sleeps, nothing pings and the cache expires as usual.
- Each open session keeps its own cache warm, and each one costs pings. Close sessions you're done with.
- Only the main conversation is tracked; subagent requests are ignored.

---

## Options

Change them in `/config` (the usage-footer rows). They're stored in `~/.claude/settings.json` under `pluginConfigs`, and a change reloads the mod.

| Option | Default | Meaning |
|---|---|---|
| `keepAlive` | `true` | Master switch for pings and evening compaction. The footer stays either way. |
| `keepAliveFrom` | `07:00` | Work hours start (local time). |
| `keepAliveUntil` | `20:00` | Work hours end. After this an idle session is compacted instead of kept warm. A window across midnight (e.g. `22:00`–`06:00`) is allowed. |
| `utcOffset` | empty | Empty means the system timezone. Set it (e.g. `+07:00`) if work hours look shifted. |
| `cacheTtlMinutes` | `60` | Assumed cache lifetime. Keep 60; lower it only for a quick test. |

### Quick live test

1. In `/config`, set `cacheTtlMinutes` to `7` and `keepAliveUntil` to about 15 minutes from now.
2. Send a message, then stay idle.
3. About 2 minutes after the request started, expect `usage-footer: keep-alive ping at HH:MM` and the countdown restarting.
4. After the cutoff, on the next near-expiry, expect `usage-footer: compacted at HH:MM, idle outside work hours`.
5. Set the options back to `60` and `20:00`.

---

## Install / copy to another computer

The mod and the status line script are part of the `claude-setup` repo: follow "New machine" in `README.md`.

### Requirements

- Claude Code with mods support (built on **2.1.289**; check with `claude --version`).
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
├── hooks/register.tsx                   hooks: footer, timers, ping/compact
├── hooks/keepalive.ts                   pure logic: decide(), time helpers, wasCacheCold()
├── hooks/register.test.ts               footer and keep-alive tests
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
| `turn.step` | Records the request start time and effort |
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
