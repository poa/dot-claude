# Remote Control

Steer a Claude Code session that runs on this machine from the Claude phone app, claude.ai/code or the desktop app. Claude keeps running here, with your files, tools and mods; the phone is a window into the session. The source is the Claude Code docs ([Remote Control](https://code.claude.com/docs/en/remote-control)); the commands below were checked against Claude Code 2.1.296.

## Turn it on

1. Run `./install.sh --remote-control` from this repo. It edits `env` in `~/.claude/settings.json` and keeps the old file as `settings.json.bak`; see "Install options" in [`README.md`](../README.md#install-options).
2. Restart Claude Code. Environment variables are read only at startup.
3. Sign in with a claude.ai Pro, Max, Team or Enterprise account (`/login`). API keys don't work, nor does `ANTHROPIC_BASE_URL` pointing anywhere but Anthropic. On Team and Enterprise an owner must enable Remote Control first.
4. Install the Claude app on the phone and sign in with the same account. `/mobile` in Claude Code shows a QR code for the app store.

Why the install option: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off the feature flags Remote Control needs, and setting it to `0` doesn't help; it has to be unset. The option replaces it with the flags it implied (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`), so telemetry, error reports and auto-updates stay off in every launch, the desktop app and IDE included. Release notes and the PR status badge come back. `DISABLE_TELEMETRY` alone leaves Remote Control available.

## Use it

- In a running session: `/rc` (or `/remote-control`). The footer shows `/rc active` when there's room; run `/rc` again for the URL, a QR code and a disconnect button.
- A new session with it on: `claude --rc "name"`.
- A server that starts new sessions from the phone: `claude remote-control --spawn worktree --name "name"`. Each session the phone starts gets its own git worktree (`--spawn same-dir` shares the folder; `--capacity N` limits concurrent sessions). Press spacebar for the QR code, `w` to switch spawn mode.
- Find a session on the phone: Code tab, then the session with the computer icon and a green dot. Names can be changed there.

Through the `claude` function, `claude remote-control` works too: Claude Code refuses `--settings` for it, so [`shell/claude.sh`](../shell/claude.sh) passes the `env` block of this repo's `settings.json` and the mods as environment variables instead. Sessions started that way have the mods and the privacy flags, but not the status line, theme or editor mode.

## Phone notifications

In `/config`, turn on **Push when actions required** (permission prompts and questions) and, if you like, **Push when Claude decides** (a long task finished). Without them a session waiting for approval just sits there.

## Keep it running

- Remote Control is a local process. Closing the terminal, or the PC or WSL going to sleep, takes the session offline. Run the server inside `tmux` so closing the window doesn't stop it.
- After a stop, `claude remote-control` in the same directory brings its sessions back for about four hours; `--continue` brings back only the first one. A session you started with `--rc` comes back with `claude --continue`.
- The connection is outbound HTTPS only; no port is opened. If the proxy (`HTTPS_PROXY`) answers 403 for more than three minutes, the session disconnects.

## Trusted devices

Don't switch on **Require trusted devices** in the claude.ai account settings while `DISABLE_TELEMETRY` is set: with it, Remote Control stops working until the variable is unset. Without it, whoever has your claude.ai login can steer these sessions from a browser; use a strong sign-in. Anything Claude does through Remote Control runs with this machine's files and tools, under the permission mode of the session.

## Turn it off

- One session: `/rc` again, then disconnect.
- Everywhere: `./install.sh --no-remote-control` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` again (the four flags stay), then restart Claude Code. Or set `"disableRemoteControl": true` in `~/.claude/settings.json` to keep the other features.
