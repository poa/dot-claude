# claude-setup

Personal Claude Code configuration, kept in git and shared between workstations. Not tied to any project.

The repo can live anywhere. `install.sh` writes its location to `CLAUDE_SETUP_DIR` in `~/.zshrc` and `~/.bashrc`, and everything else is built from that variable; see "Moving the repo".

## Contents

| Path | How Claude Code uses it |
|---|---|
| `global/CLAUDE.md` | Linked as `~/.claude/CLAUDE.md`: instructions for every project |
| `keybindings.json` | Linked as `~/.claude/keybindings.json` |
| `statusline-command.sh` | Status line script, run in place (`statusLine` in `settings.json`, through `$CLAUDE_SETUP_DIR`) |
| `mods/` | Mods, one folder each; the `claude` function loads all of them (`CLAUDE_CODE_PLUGIN_DIRS=$CLAUDE_SETUP_DIR/mods`). `mods/usage-footer/`: see `docs/usage-footer.md` |
| `settings.json` | Layered over `~/.claude/settings.json` by the `claude` function; see "Settings" |
| `shell/claude.sh` | Defines the `claude` shell function (this repo's settings and mods) and the shell binding for Ctrl+Enter; sourced from `~/.zshrc` and `~/.bashrc` |
| `install.sh` | Creates the links, the `CLAUDE_SETUP_DIR` lines in `~/.zshrc` and `~/.bashrc` (whichever exist) and the `post-merge` git hook; safe to re-run, and repoints everything after a move |

## Settings

The `claude` shell function runs `claude --settings "$CLAUDE_SETUP_DIR/settings.json"`, so Claude Code loads two files and merges them:

```
~/.claude/settings.json      per machine, not in git
        +
settings.json (this repo)    passed with --settings, synced by git
        =
the settings the session uses
```

- Different keys: both apply. The `env` blocks are merged variable by variable (tested on 2.1.289, 2026-10-11).
- Same key in both files: this repo's file wins.
- Without the function (`command claude`, the IDE extension, the desktop app, scripts), only `~/.claude/settings.json` is loaded: no footer, no status line, default theme and editor mode, and none of the `DISABLE_*` flags from this repo. The proxy still applies, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` still turns off telemetry, error reporting, auto-updates and `/bug` (per the Claude Code docs).

### What goes where

- Points to a file in this repo (a script, a hook command): `settings.json` here, with the path written as `$CLAUDE_SETUP_DIR/…` (commands run in a shell, which expands it). A new mod needs no setting: put it in its own folder under `mods/`.
- Same on every machine (privacy flags, `theme`, `editorMode`): `settings.json` here. Applies only to launches through the `claude` function.
- Differs per machine, or must apply even without the function (proxy, `NO_PROXY`, `SHELL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`): `~/.claude/settings.json` on each machine, copied by hand.
- Changed by `/config`, `/model`, `/effort` or plugin options: leave it to Claude Code, which writes it to `~/.claude/settings.json`. A copy here would override your change at every launch. That's now the case for `theme` and `editorMode`: change them in this file, not in `/config`.

### Current split

- `settings.json` here: `statusLine`, `theme`, `editorMode`, and in `env`: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`.
- `~/.claude/settings.json`, `env` block: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `SHELL`. The other keys there (`model`, `effortLevel`, `modelSettings`, `voice` and so on) are written by Claude Code.

### Applying and checking changes

- Restart Claude Code after changing `env` in either file: environment variables are read only at startup.
- To see what a running session got, type `! printenv | grep -E 'PROXY|DISABLE|SHELL|PLUGIN_DIRS'` at its prompt.

### Env block sample
```
  "env": {
    "HTTPS_PROXY": "http://localhost:1080",
    "HTTP_PROXY": "http://localhost:1080",
    "NO_PROXY": "localhost, 127.0.0.1, 10.*, 172.16.*, 192.168.*",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "SHELL": "/usr/bin/bash"
  },

```

## Keys

`keybindings.json` makes `Enter` and `Shift+Enter` insert a new line; `Ctrl+Enter` and `Ctrl+K` send.

### Windows Terminal: make Ctrl+Enter send

Windows Terminal sends `Ctrl+Enter` as plain `Enter`, so Claude Code can't tell them apart. A `sendInput` action makes it send `ESC[13;5u` (the extended-keys code for Ctrl+Enter) instead. Tested with Claude Code 2.1.289 under WSL, 2026-10-11.

1. Open Windows Terminal's `settings.json`: `Ctrl+Shift+,` in Windows Terminal, or `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json` (from WSL: `/mnt/c/Users/<user>/AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json`).
2. Back it up, e.g. as `settings.json.bak-<date>` next to it.
3. Add one entry to the existing `actions` list and one to the existing `keybindings` list (create a list if it's missing; don't replace the other entries):
    ```json
    "actions": [
        { "command": { "action": "sendInput", "input": "\u001b[13;5u" }, "id": "User.sendInput.CtrlEnterCsiU" },
        …
    ],
    "keybindings": [
        { "id": "User.sendInput.CtrlEnterCsiU", "keys": "ctrl+enter" },
        …
    ]
    ```
4. Save. Windows Terminal reloads the file by itself; if it shows a settings error, the JSON is broken: restore the backup.
5. Run `exec zsh` in open tabs so the shell binding from `shell/claude.sh` loads.
6. Test: in Claude Code, `Ctrl+Enter` sends and `Enter` inserts a new line; at a zsh prompt, `Ctrl+Enter` runs the command like `Enter`.

Notes:

- The mapping applies to every Windows Terminal tab. `shell/claude.sh` binds the code to `accept-line` in zsh and bash, so there it acts as `Enter`. In PowerShell, `Ctrl+Enter` no longer inserts a line above.
- If a future Claude Code version stops reading `ESC[13;5u` as Ctrl+Enter, try the other common encoding, `\u001b[27;5;13~`, in the action (and in the `shell/claude.sh` bindings).
- To undo, restore the backup or delete the two entries.
- Without the mapping, `Ctrl+Enter` inserts a new line; `Ctrl+K` sends in any terminal.

## New machine

1. Install `git`, `jq` and a Nerd Font (for the status line icons).
2. Clone the repo anywhere, for example to `~/git/pers/claude-setup`.
3. Run `install.sh` from the clone. If it reports `DRIFT`, the machine already has a different `~/.claude/CLAUDE.md` or `keybindings.json`: merge it into the repo, delete the original and run the script again.
4. Add the `env` variables listed in "Current split" to `~/.claude/settings.json` (see "Env block sample"), copying the values from another machine and adjusting the proxy. Don't add `CLAUDE_CODE_PLUGIN_DIRS` or `statusLine` there.
5. On Windows, add the Windows Terminal mapping from "Keys".
6. Open a new terminal (or run `exec zsh`) and start `claude`. Check with `whence -v claude` (zsh) or `type claude` (bash): it must show a shell function.

## Moving the repo

1. Move the folder.
2. Run `install.sh` from the new location. It rewrites `CLAUDE_SETUP_DIR` in `~/.zshrc` and `~/.bashrc` and repoints the `~/.claude` links and the git hook.
3. Open new terminals (or run `exec zsh`) and restart Claude Code sessions.

Until step 2, the `~/.claude` links point to the old location and the `claude` function finds nothing.

## Day to day

- Edits to linked or in-place files (`/memory`, keybindings, the mod, the status line script) land in the repo: commit and push.
- `git pull` on another machine re-runs `install.sh` through the hook. Restart Claude Code to pick up settings changes; mod edits hot-reload.
- `DRIFT` from `install.sh`: something replaced a link with a regular file. Diff the two, merge into the repo, delete the file and re-run.
- Mod checks: `claude plugin validate mods/usage-footer` and `claude plugin test mods/usage-footer`.
