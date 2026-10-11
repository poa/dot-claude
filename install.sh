#!/usr/bin/env bash
# Link this repo into ~/.claude and the shell rc files. Safe to re-run; also runs as the post-merge hook.
# After moving the repo, run install.sh from the new location: it repoints everything.
set -euo pipefail
repo=$(dirname "$(readlink -f "$0")")
rc=0

# link <file in repo> <path>: replaces an identical copy, refuses to overwrite a different one
link() {
  local src=$repo/$1 dst=$2
  if [[ -e $dst && ! -L $dst ]]; then
    if cmp -s "$src" "$dst"; then rm "$dst"
    else echo "DRIFT: $dst differs from $1; merge it into the repo and re-run" >&2; return 1
    fi
  fi
  ln -sfn "$src" "$dst"
}

mkdir -p ~/.claude
link global/CLAUDE.md ~/.claude/CLAUDE.md || rc=1
link keybindings.json ~/.claude/keybindings.json || rc=1

# Shell setup: export CLAUDE_SETUP_DIR (this repo) and source shell/claude.sh, at the end of each existing rc file.
# Older or moved copies of these lines are replaced.
block=$(printf '# Claude Code setup\nexport CLAUDE_SETUP_DIR=%q\n[ -f "$CLAUDE_SETUP_DIR/shell/claude.sh" ] && . "$CLAUDE_SETUP_DIR/shell/claude.sh"' "$repo")
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

# Re-run after every git pull
ln -sfn ../../install.sh "$repo/.git/hooks/post-merge"
exit $rc
