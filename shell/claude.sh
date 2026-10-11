# Sourced from ~/.bashrc and ~/.zshrc (lines added by install.sh); works in both shells.
# Layers this repo's settings.json over ~/.claude/settings.json; env keys from both are merged.
alias claude='claude --settings ~/git/pers/claude-setup/settings.json'

# Windows Terminal sends ESC[13;5u for Ctrl+Enter (sendInput action) so Claude Code can tell it from Enter.
# At the shell prompt, treat it as Enter instead of printing the code.
if [ -n "$ZSH_VERSION" ]; then
  bindkey '^[[13;5u' accept-line
elif [ -n "$BASH_VERSION" ] && [[ $- == *i* ]]; then
  bind '"\e[13;5u": accept-line'
fi
