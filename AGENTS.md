# AGENTS.md

Instructions for AI agents working in this repository. [`README.md`](README.md) describes how the repo is wired into `~/.claude`.

## Rules

- [`global/CLAUDE.md`](global/CLAUDE.md) is the user-level instruction file for every project (`~/.claude/CLAUDE.md` links to it). Change it only when asked.
- Never hardcode the repo path. Use `$CLAUDE_SETUP_DIR`, which the rc lines written by `install.sh` export; in `settings.json` only inside commands, which run in a shell.
- New mods go in their own folder under `mods/`; the `claude` function loads all of them.
- `settings.json` holds settings shared by every machine (privacy flags, `theme`, `editorMode`, the status line command). The proxy, `SHELL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and keys Claude Code writes itself stay in `~/.claude/settings.json`, outside git. See "Settings" in [`README.md`](README.md#settings).
- Never copy `~/.claude` runtime data into the repo: `.credentials.json`, `history.jsonl`, `projects/`, `file-history/`, `sessions/`.
- The repo is public. Before every commit, check what will be committed (staged and new files, the commit message, the author email) for sensitive data: credentials or tokens, email addresses other than the GitHub noreply one, user, machine, host or work project names, absolute home paths, proxy addresses, internal IPs or URLs. If you find any, stop and ask instead of committing.
- When you add, move or rename a file that `install.sh` links, update `install.sh` and [`README.md`](README.md), then run `./install.sh`.
- Session scripts go in `bin/` with shared functions in `lib/sessions.sh`. Scripts that change `~/.claude/projects` are dry runs unless given `--go`, back up what they rewrite or move, and skip running sessions (`live_sessions`). Build project folder names with `enc`, never by hand. Don't put user, machine or project names in them, including help examples.
- After changing the mod, run `claude plugin validate mods/usage-footer` and `claude plugin test mods/usage-footer`.
- Footer and status line output must fit a terminal a half or a third of the screen wide.
- The `bin/` scripts print plain tables (one row per item, no headings or grouping) so `cut`, `awk` and `sort` work on them. Only `fit` in `lib/sessions.sh` handles narrow terminals, by cutting lines that are too long.
- Markdown: one line per paragraph or list item (no hard wrapping).
- Markdown: write references to other `.md` files in the repo as relative links, with a `#heading` anchor when they point to a section (`` [`README.md`](README.md#settings) ``), so they work on the rendered page. Files outside the repo, such as `~/.claude/CLAUDE.md`, stay as code.
