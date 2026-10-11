#!/bin/bash
# Statusline converted from ~/.bashrc PS1 (color prompt):
#   PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
# (The trailing "\$ " is intentionally dropped per statusline conventions.)
# Model/effort/usage are shown by the usage-footer mod in the prompt footer instead.

export LC_ALL=C.UTF-8  # so ${#var} counts characters, not bytes
input=$(cat)

# Warn when the prompt cache is not the 1-hour one (e.g. usage overage drops it to 5m):
# the usage-footer keep-alive pings assume a 1-hour lifetime.
ttl=$(jq -r '.prompt_cache.ttl // empty' <<<"$input" 2>/dev/null)
ttl_segment=""
if [ -n "$ttl" ] && [ "$ttl" != "1h" ]; then
    ttl_segment=$(printf ' \033[01;31mcache %s\033[00m' "$ttl")
fi

chroot="${debian_chroot:+($debian_chroot)}"
user=$(whoami)
host=$(hostname -s)
dir=$(pwd)

git_segment=""
branch=$(git -C "$dir" branch --show-current 2>/dev/null)
if [ -z "$branch" ] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    branch=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)
fi
# Styled after oh-my-bash's powerbash10k scm segment: nf-fa-git + nf-fa-code_fork icons
# (Nerd Font glyphs U+F1D3, U+F126), bold green branch, green ✓ clean / red ✗ dirty.
if [ -n "$branch" ]; then
    if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null | head -1)" ]; then
        state=$'\033[01;31m✗'
    else
        state=$'\033[01;32m✓'
    fi
    git_segment=$(printf ' \033[01;32m\xef\x87\x93  \xef\x84\xa6 %s %s\033[00m' "$branch" "$state")
fi

build_left() {
    printf '%s\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m%s%s' "$chroot" "$user" "$host" "$1" "$git_segment" "$ttl_segment"
}

visible_len() { local s; s=$(sed -E 's/\x1b\[[0-9;]*m//g' <<<"$1"); echo "${#s}"; }
# Leaves room for the TUI's own padding so the line never wraps.
margin=4
width=${COLUMNS:-0}

line=$(build_left "$dir")

# Too wide for the terminal: shorten leading path components to their first
# letter, left to right (p10k-style), keeping the last component intact.
if [ "$width" -gt 0 ] && [ "$(visible_len "$line")" -gt $(( width - margin )) ]; then
    IFS='/' read -ra parts <<<"$dir"
    for (( i = 0; i < ${#parts[@]} - 1; i++ )); do
        [ ${#parts[i]} -gt 1 ] || continue
        parts[i]=${parts[i]:0:1}
        line=$(build_left "$(IFS='/'; echo "${parts[*]}")")
        [ "$(visible_len "$line")" -gt $(( width - margin )) ] || break
    done
fi

printf '%s' "$line"
