# Sourced from ~/.zshrc and ~/.bashrc by the line install.sh adds, which also exports CLAUDE_SETUP_DIR (this repo).
# Works in both shells. Nothing here hardcodes the repo path.
[ -n "$CLAUDE_SETUP_DIR" ] || return 0

# claude: layers this repo's settings.json over ~/.claude/settings.json (env keys from both are merged)
# and loads every mod under mods/ (a folder of plugins).
# `claude remote-control` refuses --settings, so it gets the env block of settings.json (and the mods) as
# environment variables instead; the sessions it starts inherit them, but not the status line, theme or editor mode.
# In Git Bash, Claude Code is a Windows program: it gets this repo's paths as C:/..., and a native jq.exe ends
# lines with CRLF. Git Bash also rewrites arguments that start with / for a Windows program (/init becomes
# C:/Program Files/Git/init) but passes //init on as /init, so the slash is doubled for arguments that aren't
# existing paths. MSYS_NO_PATHCONV would stop the rewriting too, but Claude Code would hand it on to every command it runs.
unalias claude 2>/dev/null
claude() {
  local dir=$CLAUDE_SETUP_DIR a args=()
  case $OSTYPE in msys* | cygwin*) dir=$(cygpath -m "$dir") ;; esac
  case $OSTYPE in
    msys*)    # Cygwin passes arguments as they are
      for a in "$@"; do
        case $a in /[!/]* | /) [ -e "$a" ] || a=/$a ;; esac
        args+=("$a")
      done
      set -- "${args[@]}"
      ;;
  esac
  # `claude plugin ...` refuses options before `plugin`, and has no use for the settings or mods
  if [ "$1" = plugin ]; then command claude "$@"; return; fi
  if [ "$1" = remote-control ] && command -v jq >/dev/null 2>&1; then
    local vars=() kv
    while IFS= read -r kv; do vars+=("${kv%$'\r'}"); done < <(jq -r '.env // {} | to_entries[] | "\(.key)=\(.value)"' "$CLAUDE_SETUP_DIR/settings.json")
    env "${vars[@]}" CLAUDE_CODE_PLUGIN_DIRS="$dir/mods" claude "$@"
    return
  fi
  CLAUDE_CODE_PLUGIN_DIRS="$dir/mods" \
    command claude --settings "$dir/settings.json" "$@"
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
