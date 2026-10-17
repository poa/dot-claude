# Sourced from ~/.zshrc and ~/.bashrc by the line install.sh adds, which also exports CLAUDE_SETUP_DIR (this repo).
# Works in both shells. Nothing here hardcodes the repo path.
[ -n "$CLAUDE_SETUP_DIR" ] || return 0

# claude: layers this repo's settings.json over ~/.claude/settings.json (env keys from both are merged)
# and loads every mod under mods/ (a folder of plugins).
# `claude remote-control` refuses --settings, so it gets the env block of settings.json (and the mods) as
# environment variables instead; the sessions it starts inherit them, but not the status line, theme or editor mode.
unalias claude 2>/dev/null
claude() {
  if [ "$1" = remote-control ] && command -v jq >/dev/null 2>&1; then
    local vars=() kv
    while IFS= read -r kv; do vars+=("$kv"); done < <(jq -r '.env // {} | to_entries[] | "\(.key)=\(.value)"' "$CLAUDE_SETUP_DIR/settings.json")
    env "${vars[@]}" CLAUDE_CODE_PLUGIN_DIRS="$CLAUDE_SETUP_DIR/mods" claude "$@"
    return
  fi
  CLAUDE_CODE_PLUGIN_DIRS="$CLAUDE_SETUP_DIR/mods" \
    command claude --settings "$CLAUDE_SETUP_DIR/settings.json" "$@"
}

# Session tools: claude-sessions.sh and the rest of bin/
case ":$PATH:" in *":$CLAUDE_SETUP_DIR/bin:"*) ;; *) PATH="$PATH:$CLAUDE_SETUP_DIR/bin" ;; esac

# Windows Terminal sends ESC[13;5u for Ctrl+Enter (sendInput action) so Claude Code can tell it from Enter.
# At the shell prompt, treat it as Enter instead of printing the code.
if [ -n "$ZSH_VERSION" ]; then
  bindkey '^[[13;5u' accept-line
elif [ -n "$BASH_VERSION" ] && [[ $- == *i* ]]; then
  bind '"\e[13;5u": accept-line'
fi
