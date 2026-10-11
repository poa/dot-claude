#!/usr/bin/env bash
# Link this repo into ~/.claude and ~/.bashrc. Safe to re-run; also runs as the post-merge hook.
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

# The claude alias (loads settings.json from this repo), for each shell that has an rc file
line="[ -f $repo/shell/claude.sh ] && . $repo/shell/claude.sh"
found=0
for rcfile in ~/.bashrc ~/.zshrc; do
  [[ -e $rcfile ]] || continue
  found=1
  if ! grep -qxF "$line" "$rcfile"; then
    printf '\n# Claude Code setup\n%s\n' "$line" >> "$rcfile"
    echo "Added the claude alias to $rcfile; open a new terminal or run: . $rcfile"
  fi
done
[[ $found = 1 ]] || { echo "No ~/.bashrc or ~/.zshrc; add this line to your shell's rc file: $line" >&2; rc=1; }

# Re-run after every git pull
ln -sfn ../../install.sh "$repo/.git/hooks/post-merge"
exit $rc
