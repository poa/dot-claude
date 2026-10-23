#!/usr/bin/env bash
# Link this repo into ~/.claude and the shell rc files. Safe to re-run; also runs as the post-merge hook.
# After moving the repo, run install.sh from the new location: it repoints everything.
set -euo pipefail
repo=$(dirname "$(readlink -f "$0")")
rc=0

# Git Bash (or Cygwin) on Windows: ln -s copies unless told to make real Windows links, and a native
# jq.exe ends its lines with CRLF
case $OSTYPE in
  msys* | cygwin*)
    windows=1
    export MSYS="${MSYS:-} winsymlinks:nativestrict" CYGWIN="${CYGWIN:-} winsymlinks:nativestrict"
    jq() { command jq "$@" | tr -d '\r'; return "${PIPESTATUS[0]}"; }
    ;;
  *) windows=0 ;;
esac

# symlink <target> <link>: ln -sfn, saying what Windows needs when it refuses
symlink() {
  ln -sfn "$1" "$2" && return 0
  [[ $windows = 0 ]] || echo "Windows makes symlinks only with Developer Mode on (Settings > System > For developers) or as administrator" >&2
  return 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--agents | --no-agents] [--remote-control | --no-remote-control]

Links this repo into ~/.claude and the shell rc files. Without
options, keeps what this machine already has; a new machine
gets none of the optional parts.

  --agents      Link agents/ as ~/.claude/agents: Explore on
                Haiku, implementer on Sonnet
  --no-agents   Remove that link
  --remote-control
                Allow Remote Control: in ~/.claude/settings.json,
                drop CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and
                set the DISABLE_* flags it implied one by one
  --no-remote-control
                Set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC again
  -h, --help    Show this help
EOF
}

# Each option is on, off or keep (not given: leave the machine as it is)
agents=keep
remote=keep
for arg; do
  case $arg in
    --agents) agents=on ;;
    --no-agents) agents=off ;;
    --remote-control) remote=on ;;
    --no-remote-control) remote=off ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

# link <file in repo> <path>: replaces an identical copy, refuses to overwrite a different one
link() {
  local src=$repo/$1 dst=$2
  if [[ -e $dst && ! -L $dst ]]; then
    if cmp -s "$src" "$dst"; then rm "$dst"
    else echo "DRIFT: $dst differs from $1; merge it into the repo and re-run" >&2; return 1
    fi
  fi
  symlink "$src" "$dst"
}

mkdir -p ~/.claude
link global/CLAUDE.md ~/.claude/CLAUDE.md || rc=1
link keybindings.json ~/.claude/keybindings.json || rc=1

# agents_link on|off: ~/.claude/agents as a link to agents/. An empty folder there is replaced, one with files is not.
agents_link() {
  local dst=~/.claude/agents before
  before=$(readlink "$dst" || true)
  if [[ $1 = off ]]; then
    [[ -L $dst ]] || return 0
    rm "$dst"
    echo "Removed the $dst link; restart Claude Code"
    return 0
  fi
  if [[ -d $dst && ! -L $dst ]]; then
    rmdir "$dst" 2>/dev/null || { echo "DRIFT: $dst has files; move them into agents/ and re-run" >&2; return 1; }
  elif [[ -e $dst && ! -L $dst ]]; then
    echo "DRIFT: $dst is a file; remove it and re-run" >&2
    return 1
  fi
  symlink "$repo/agents" "$dst" || return 1
  [[ $before = "$repo/agents" ]] || echo "Linked $dst to agents/; restart Claude Code"
}
# Without the option, an existing link is repointed (the repo may have moved) and no link stays no link
if [[ $agents = keep && -L ~/.claude/agents ]]; then agents=on; fi
if [[ $agents != keep ]]; then agents_link "$agents" || rc=1; fi

# remote_control on|off: edits the env block of ~/.claude/settings.json (kept as ~/.claude/settings.json.bak).
# Remote Control needs CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC unset; on, the flags it implied are set one by one.
remote_control() {
  local file=~/.claude/settings.json new
  command -v jq >/dev/null || { echo "jq is needed for --remote-control and --no-remote-control" >&2; return 1; }
  file=$(readlink -f "$file")
  [[ -f $file ]] || echo '{}' > "$file"
  if [[ $1 = on ]]; then
    new=$(jq '.env = (({DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", DISABLE_BUG_COMMAND: "1"} + (.env // {})) | del(.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC))' "$file")
  else
    new=$(jq '.env = ((.env // {}) + {CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"})' "$file")
  fi
  [[ $(jq -S -c . "$file") != "$(jq -S -c . <<<"$new")" ]] || return 0
  cp -p "$file" "$file.bak"
  printf '%s\n' "$new" > "$file.tmp" && mv "$file.tmp" "$file"
  echo "Changed env in $file (previous copy: $file.bak); restart Claude Code sessions"
}
if [[ $remote != keep ]]; then remote_control "$remote" || rc=1; fi

# Shell setup: export CLAUDE_SETUP_DIR (this repo) and source shell/claude.sh, at the end of each existing rc file.
# Older or moved copies of these lines are replaced.
block=$(printf '# Claude Code setup\nexport CLAUDE_SETUP_DIR=%q\n[ -f "$CLAUDE_SETUP_DIR/shell/claude.sh" ] && . "$CLAUDE_SETUP_DIR/shell/claude.sh"' "$repo")
# A new Git Bash has no ~/.bashrc; on its next start it adds a ~/.bash_profile that loads this one
if [[ $windows = 1 && ! -e ~/.bashrc && ! -e ~/.zshrc ]]; then : > ~/.bashrc; echo "Created ~/.bashrc"; fi
found=0
for rcfile in ~/.zshrc ~/.bashrc; do
  [[ -e $rcfile ]] || continue
  found=1
  new=$(
    awk '/^# Claude Code setup$/ || /^export CLAUDE_SETUP_DIR=/ || /^\[ -f .*shell\/claude\.sh/ { next } { print }' "$rcfile" |
      awk '{ l[NR] = $0 } END { n = NR; while (n > 0 && l[n] == "") n--; for (i = 1; i <= n; i++) print l[i] }'
    printf '\n%s' "$block"
  )
  if [[ $new != "$(cat "$rcfile")" ]]; then
    printf '%s\n' "$new" > "$rcfile"
    shell=${rcfile##*/.}
    echo "Updated the Claude Code setup lines in $rcfile; open a new terminal or run: exec ${shell%rc}"
  fi
done
[[ $found = 1 ]] || { printf 'No ~/.zshrc or ~/.bashrc; add these lines to your shell rc file:\n%s\n' "$block" >&2; rc=1; }

# Re-run after every git pull: a script rather than a link to install.sh, which would get the hook's
# argument (the squash flag) as an option. Git runs hooks from the top of the work tree.
# Git Bash on a clone in WSL leaves it to WSL's install.sh: a file written from Windows there isn't
# executable, and git skips such a hook.
hook=$repo/.git/hooks/post-merge
hook_text=$'#!/bin/sh\n# Written by install.sh\nexec ./install.sh'
if [[ $windows = 1 && ( $repo == //wsl.localhost/* || $repo == //wsl\$/* ) ]]; then
  :
elif [[ -L $hook || ! -f $hook || $(cat "$hook") != "$hook_text" ]]; then
  rm -f "$hook"    # first, so that writing doesn't go through an old link into install.sh
  printf '%s\n' "$hook_text" > "$hook"
  chmod +x "$hook"
fi
exit $rc
