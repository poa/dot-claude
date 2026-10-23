# dot-claude

Personal Claude Code configuration, kept in git and shared between workstations. Not tied to any project.

The repo can live anywhere. `install.sh` writes its location to `CLAUDE_SETUP_DIR` in `~/.zshrc` and `~/.bashrc`, and everything else is built from that variable; see "Moving the repo".

## Contents

| Path | How Claude Code uses it |
|---|---|
| [`global/CLAUDE.md`](global/CLAUDE.md) | Linked as `~/.claude/CLAUDE.md`: instructions for every project |
| `keybindings.json` | Linked as `~/.claude/keybindings.json` |
| `agents/` | Subagents; linked as `~/.claude/agents` with `install.sh --agents` (see "Install options") |
| `statusline-command.sh` | Status line script, run in place (`statusLine` in `settings.json`, through `$CLAUDE_SETUP_DIR`) |
| `mods/` | Mods, one folder each; the `claude` function loads all of them (`CLAUDE_CODE_PLUGIN_DIRS=$CLAUDE_SETUP_DIR/mods`). `mods/usage-footer/`: see [`docs/usage-footer.md`](docs/usage-footer.md) |
| `settings.json` | Layered over `~/.claude/settings.json` by the `claude` function; see "Settings" |
| `shell/claude.sh` | Defines the `claude` shell function (this repo's settings and mods; `claude remote-control` gets them as environment variables) and the shell binding for Ctrl+Enter, and puts `bin/` on `PATH`; sourced from `~/.zshrc` and `~/.bashrc` |
| `docs/` | Notes: [`usage-footer.md`](docs/usage-footer.md), [`remote-control.md`](docs/remote-control.md) |
| `bin/` | Scripts that list, prune and repair sessions in `~/.claude/projects`, weigh the keep-alive's usage, and A/B test instruction sets; see "Session tools" |
| `lib/sessions.sh` | Functions shared by the `bin/` scripts |
| `install.sh` | Creates the links, the `CLAUDE_SETUP_DIR` lines in `~/.zshrc` and `~/.bashrc` (whichever exist) and the `post-merge` git hook; safe to re-run, and repoints everything after a move. Optional parts are switched on by options; see "Install options" |
| `.gitattributes` | Keeps LF line endings in every clone, Windows included: bash fails on CRLF scripts |

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
- Without the function (`command claude`, the IDE extension, the desktop app, scripts), only `~/.claude/settings.json` is loaded: no footer, no status line, default theme and editor mode, and none of the `DISABLE_*` flags from this repo. The proxy still applies, and, if it's set, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` still turns off telemetry, error reporting, auto-updates and `/bug` (per the Claude Code docs). It also turns off Remote Control, which is why `install.sh --remote-control` replaces it with the individual flags in `~/.claude/settings.json`.
- `claude remote-control` is the exception: Claude Code refuses `--settings` there, so the function runs it without and passes the `env` block of this repo's `settings.json` and the mods as environment variables. The sessions it starts have them, but not the status line, theme or editor mode.

### What goes where

- Points to a file in this repo (a script, a hook command): `settings.json` here, with the path written as `$CLAUDE_SETUP_DIR/…` (commands run in a shell, which expands it). A new mod needs no setting: put it in its own folder under `mods/`.
- Same on every machine (privacy flags, `theme`, `editorMode`): `settings.json` here. Applies only to launches through the `claude` function.
- Differs per machine, or must apply even without the function (proxy, `NO_PROXY`, `SHELL`, and the privacy flags that must reach the desktop app and IDE too): `~/.claude/settings.json` on each machine, copied by hand.
- Changed by `/config`, `/model`, `/effort` or plugin options: leave it to Claude Code, which writes it to `~/.claude/settings.json`. A copy here would override your change at every launch. That's now the case for `theme` and `editorMode`: change them in this file, not in `/config`.

### Current split

- `settings.json` here: `statusLine`, `theme`, `editorMode`, and in `env`: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`.
- `~/.claude/settings.json`, `env` block: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SHELL`, and either `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or, after `install.sh --remote-control`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`. The other keys there (`model`, `effortLevel`, `modelSettings`, `voice` and so on) are written by Claude Code.

### Applying and checking changes

- Restart Claude Code after changing `env` in either file: environment variables are read only at startup.
- To see what a running session got, type `! printenv | grep -E 'PROXY|DISABLE|SHELL|PLUGIN_DIRS'` at its prompt.

### Env block sample

This is what `install.sh --remote-control` leaves. Without Remote Control, `"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"` replaces the four `DISABLE_*` lines.

```
  "env": {
    "HTTPS_PROXY": "http://localhost:1080",
    "HTTP_PROXY": "http://localhost:1080",
    "NO_PROXY": "localhost, 127.0.0.1, 10.*, 172.16.*, 192.168.*",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_BUG_COMMAND": "1",
    "SHELL": "/usr/bin/bash"
  },

```

## Keys

`keybindings.json` makes `Enter` and `Shift+Enter` insert a new line; `Ctrl+Enter` sends. `Ctrl+X Enter`, a Claude Code default, also sends, in any terminal. `Ctrl+K` keeps its default, deleting from the cursor to the end of the line.

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
5. Run `exec zsh` (or `exec bash`) in open tabs so the shell binding from `shell/claude.sh` loads.
6. Test: in Claude Code, `Ctrl+Enter` sends and `Enter` inserts a new line; at a zsh or bash prompt, `Ctrl+Enter` runs the command like `Enter`.

Notes:

- The mapping applies to every Windows Terminal tab. `shell/claude.sh` binds the code to `accept-line` in zsh and bash, so there it acts as `Enter`. In PowerShell, `Ctrl+Enter` no longer inserts a line above.
- If a future Claude Code version stops reading `ESC[13;5u` as Ctrl+Enter, try the other common encoding, `\u001b[27;5;13~`, in the action (and in the `shell/claude.sh` bindings).
- To undo, restore the backup or delete the two entries.
- Without the mapping, `Ctrl+Enter` inserts a new line; `Ctrl+X Enter` sends.

## Install options

`install.sh` without options keeps what the machine already has, and the `post-merge` hook runs it that way after every `git pull`. A new machine gets none of the optional parts. Each option has a `--no-` form that undoes it (`--no-remote-control` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` again and leaves the four flags); `install.sh -h` lists them.

| Option | What it changes |
|---|---|
| `--agents` | Links `agents/` as `~/.claude/agents`. `Explore` runs on Haiku and replaces the built-in code search agent; `implementer` runs on Sonnet and carries out an approved plan when you ask for it ("use the implementer agent"). Every launch loads them, the desktop app and IDE extension included. Restart Claude Code after the first link. |
| `--remote-control` | Lets Remote Control work, so you can steer sessions from the Claude phone app or claude.ai/code (see [`docs/remote-control.md`](docs/remote-control.md)). Edits `env` in `~/.claude/settings.json` (previous copy: `settings.json.bak`): removes `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which turns Remote Control off, and sets the flags it implied one by one: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`. Existing values are kept. Needs `jq`. Restart Claude Code sessions afterwards. |

The model split (Opus plans, Sonnet implements) isn't an option, because Claude Code stores the model in `~/.claude/settings.json` itself. Run `/model sonnet`, `/effort high`, then `/model opusplan` and press Enter. Plan mode then runs on Opus at its saved effort, and the work after you approve a plan runs on Sonnet at `high`. `/model opus` undoes it.

## New machine

1. Install `git`, `jq` and a Nerd Font (for the status line icons).
2. Clone the repo anywhere, for example to `~/git/pers/dot-claude`.
3. Run `install.sh` from the clone, with the options you want (see "Install options"). If it reports `DRIFT`, the machine already has a different `~/.claude/CLAUDE.md` or `keybindings.json`: merge it into the repo, delete the original and run the script again.
4. Add the `env` variables listed in "Current split" to `~/.claude/settings.json` (see "Env block sample"), copying the values from another machine and adjusting the proxy. If you want Remote Control, run `install.sh --remote-control` instead of adding `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Don't add `CLAUDE_CODE_PLUGIN_DIRS` or `statusLine` there.
5. On Windows, add the Windows Terminal mapping from "Keys".
6. Open a new terminal (or run `exec zsh` or `exec bash`) and start `claude`. Check with `whence -v claude` (zsh) or `type claude` (bash): it must show a shell function.

### Windows (Git Bash)

The same steps work in Git Bash, with native Claude Code (not under WSL, which is Linux). Run them all in Git Bash:

- Install [Git for Windows](https://git-scm.com/downloads/win), Claude Code (`irm https://claude.ai/install.ps1 | iex` in PowerShell) and `jq` (`winget install jqlang.jq`). Git for Windows brings `perl`.
- Turn on Developer Mode (Settings > System > For developers) before `install.sh`. Without it, only an administrator can make symlinks, and `install.sh` stops rather than copy the files: a copy wouldn't bring `/memory` edits back to the repo.
- `install.sh` writes the setup lines to `~/.bashrc`, and creates that file if there's none. On its next start Git Bash adds a `~/.bash_profile` that loads it, with a one-time warning.
- In `~/.claude/settings.json`, leave out `SHELL`. If Claude Code doesn't find Git Bash, add `"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"` to `env` instead.
- A clone made before `.gitattributes` existed has CRLF files that bash can't run. Commit or stash your changes, then run `git rm -rq --cached . && git reset -q --hard`.

How it works:

- Claude Code, `jq` and `git` are Windows programs there, and Git Bash rewrites arguments that start with `/` for them (`/init` becomes `C:/Program Files/Git/init`). The `claude` function gives Claude Code this repo's paths as `C:/…` and doubles the slash of arguments that aren't existing paths, so `claude "/init"` works. For other Windows programs, double the slash yourself, or set `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL='*'` on that one command; exported, they would also stop the conversion for Claude Code's own commands.
- A native `jq.exe` ends its lines with CRLF; the scripts drop the CR.
- The status line runs through Git Bash, like on Linux.
- The session tools read Windows sessions: see "Session tools".

#### Repo in WSL

Windows Claude Code can use a clone that lives in WSL, so both sides share one copy. Run `./install.sh` in Git Bash from the clone's Windows path, `//wsl.localhost/<distro>/home/<you>/…`: the `~/.claude` links on `C:` then point into WSL, and `CLAUDE_SETUP_DIR` is that path.

- Windows follows these links while its local-to-remote symlink evaluation is on, which is the default. Check with `fsutil behavior query SymlinkEvaluation` as administrator.
- Windows reads and writes the WSL files as the distro's default user (`wsl -d <distro> whoami` in PowerShell). If that's root, a file Windows creates there, such as a new agent from `/agents`, belongs to root and you can't edit it from WSL. Run `wsl --manage <distro> --set-default-user <you>`, then `wsl --terminate <distro>`.
- Opening Git Bash starts WSL, because the setup lines read `shell/claude.sh` from it; the first start takes a few seconds.
- Start Claude Code in folders on `C:`. In a folder in WSL, Windows `git` is slow and the status line takes over a second.
- Run git in WSL only. Git for Windows refuses the folder for "dubious ownership", and, with the executable bits the Linux clone tracks (`core.filemode`), would list every script as changed.
- The git hook runs `install.sh` only in WSL: `install.sh` in Git Bash doesn't write it, since a file written from Windows there isn't executable. After a pull that adds a linked file, run `./install.sh` in Git Bash too.
- Each side's session tools see only that side's `~/.claude`.

## Moving the repo

1. Move the folder.
2. Run `install.sh` from the new location. It rewrites `CLAUDE_SETUP_DIR` in `~/.zshrc` and `~/.bashrc` and repoints the `~/.claude` links and the git hook.
3. Open new terminals (or run `exec zsh`) and restart Claude Code sessions.
4. Claude Code keeps this repo's sessions and memory in a folder named after its path (see "Session tools"), so they stay under the old name. With Claude Code closed, rename `~/.claude/projects/<old name>` to the new name (move its contents if the new folder exists), then run `claude-check-cwd.sh -m rewrite -p <new name> --go` to update the path recorded in the sessions.

Until step 2, the `~/.claude` links point to the old location and the `claude` function finds nothing.

## Session tools

Scripts in `bin/` for the sessions in `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` if that's set). `shell/claude.sh` puts `bin/` on `PATH`. They need `jq`; `claude-check-cwd.sh -m rewrite` also needs `perl`. `claude-check-cwd.sh`, `claude-short-sessions.sh`, `claude-keepalive-report.sh` and `claude-compare-instructions.sh` take `-h` for options.

| Script | What it does |
|---|---|
| `claude-projects.sh` | One line per project folder: sessions, size, memory files, last activity, status and real path. Read-only. |
| `claude-sessions.sh` | One line per session: ID, last change, size, prompts, replies, project, git branch and name; sorted by project, then time. Read-only. |
| `claude-short-sessions.sh` | IDs of sessions with at most 3 replies (`-n` to change); `-v` prints them in the `claude-sessions.sh` table. Read-only; its output is meant for `claude-prune.sh`. |
| `claude-prune.sh` | Deletes sessions by ID or by its first 8 or more characters; refuses a prefix that matches several. Dry run unless the first argument is `--go`. |
| `claude-check-cwd.sh` | Finds sessions whose recorded working folder doesn't match their project folder (`MISMATCH`) or no longer exists after a rename that keeps the folder name (`GONE`, `my_repo` to `my-repo`), sessions whose project's path is gone too (`LOST`: renamed to another name, moved or deleted), and misnamed project folders. `-m rewrite` changes the recorded path; with `--to <new path>` and a `-p` matching one folder, it also moves a renamed project's sessions and `memory/` to the new path's folder. `-m move` moves the session to the folder of its path. Dry run unless `--go`; changed files are backed up to `~/claude-cwd-backup`. |
| `claude-keepalive-report.sh` | Weighs what the usage-footer keep-alive pings cost on the plan's meters against the cache rebuilds they avoid, from the log its `logUsage` option writes to `~/.claude/logs/usage`; `-w` replays the transcripts for `maxIdlePings` 0–6. Read-only; see "Does keep-alive save usage on Pro?" in [`docs/usage-footer.md`](docs/usage-footer.md#does-keep-alive-save-usage-on-pro). |
| `claude-compare-instructions.sh` | A/B test of instruction sets (a plugin, a rules file) on replayed tasks: `run` starts headless sessions per task and arm in throwaway git worktrees of a base commit, with your `CLAUDE.md` loaded, and records cost, output tokens, time, diff size and a check result; `report` gives the change per arm; `blind` writes unlabeled diff pairs to review. Tasks, results and the plugin clone live in `~/.claude/ab/`, outside the repo (task prompts may name private projects). |

- Folder names: Claude Code names a project folder after its path with every character other than a letter or digit replaced by `-` (`/home/me/my_repo.x` becomes `-home-me-my-repo-x`). A folder with any other name is `MISNAMED`: Claude Code never reads it, so its sessions don't appear in `/resume` and its memory isn't loaded. Rename folders only to that form.
- In Git Bash, sessions record Windows paths (`C:\Users\me\my_repo` is in the folder `C--Users-me-my-repo`). The scripts show them as `C:/Users/me/my_repo`, `-m rewrite` writes them back in the recorded form, and running sessions are found with `tasklist`.
- Prompts are the messages you typed; commands, tool results and summaries don't count. Replies are model responses: one prompt gets several while Claude works.
- The scripts never change or delete a session whose Claude Code process is running (they check `~/.claude/sessions`). Close other sessions before `claude-check-cwd.sh --go` anyway.
- The output is a plain table, one row per session or folder, for `cut`, `awk` and `sort`. On a terminal narrower than the table, lines are cut at its width instead of wrapping; piped output is never cut. Pipe to `less -S` to scroll sideways.

## Day to day

- Edits to linked or in-place files (`/memory` → user memory, keybindings, agents, the mod, the status line script) land in the repo: commit and push. The repo is public, [`global/CLAUDE.md`](global/CLAUDE.md) included: check `git diff` for private details before you commit. Auto memory stays in `~/.claude/projects/`, outside the repo.
- `git pull` on another machine re-runs `install.sh` through the hook. Restart Claude Code to pick up settings changes; mod edits hot-reload.
- `DRIFT` from `install.sh`: something replaced a link with a regular file. Diff the two, merge into the repo, delete the file and re-run.
- Mod checks: `claude plugin validate mods/usage-footer` and `claude plugin test mods/usage-footer`.
- Session script checks: `tests/sessions.sh` runs the scripts that change or delete sessions on fake ones in a scratch folder, never on `~/.claude`.
