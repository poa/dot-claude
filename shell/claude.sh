# Sourced from ~/.zshrc and ~/.bashrc by the line install.sh adds, which also exports CLAUDE_SETUP_DIR (this repo).
# Works in both shells. Nothing here hardcodes the repo path.
[ -n "$CLAUDE_SETUP_DIR" ] || return 0

# claude: layers this repo's settings.json over ~/.claude/settings.json (env keys from both are merged)
# and loads every mod under mods/ (a folder of plugins).
unalias claude 2>/dev/null
claude() {
  CLAUDE_CODE_PLUGIN_DIRS="$CLAUDE_SETUP_DIR/mods" \
    command claude --settings "$CLAUDE_SETUP_DIR/settings.json" "$@"
}

# Windows Terminal sends ESC[13;5u for Ctrl+Enter (sendInput action) so Claude Code can tell it from Enter.
# At the shell prompt, treat it as Enter instead of printing the code.
if [ -n "$ZSH_VERSION" ]; then
  bindkey '^[[13;5u' accept-line
elif [ -n "$BASH_VERSION" ] && [[ $- == *i* ]]; then
  bind '"\e[13;5u": accept-line'
fi
