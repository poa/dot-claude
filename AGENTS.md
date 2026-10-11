# AGENTS.md

Instructions for AI agents working in this repository. `README.md` describes how the repo is wired into `~/.claude`.

## Rules

- `global/CLAUDE.md` is the user-level instruction file for every project (`~/.claude/CLAUDE.md` links to it). Change it only when asked.
- `settings.json` holds keys that point into this repo and settings shared by every machine (privacy flags, `theme`, `editorMode`). The proxy, `SHELL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and keys Claude Code writes itself stay in `~/.claude/settings.json`, outside git. See "Settings" in `README.md`.
- Never copy `~/.claude` runtime data into the repo: `.credentials.json`, `history.jsonl`, `projects/`, `file-history/`, `sessions/`.
- When you add, move or rename a file that `install.sh` links, update `install.sh` and `README.md`, then run `./install.sh`.
- After changing the mod, run `claude plugin validate mods/usage-footer` and `claude plugin test mods/usage-footer`.
- Footer and status line output must fit a terminal a half or a third of the screen wide.
- Markdown: one line per paragraph or list item (no hard wrapping).
