#!/usr/bin/env bash
# tests/sessions.sh: runs the bin/ scripts that change or delete sessions on two fake sessions in a
# scratch folder, never on ~/.claude. One "ok" or "FAIL" line per check; exits 1 if any failed.
repo=$(dirname "$(readlink -f "$0")")/..
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home CLAUDE_CONFIG_DIR=$tmp/claude
. "$repo/lib/sessions.sh"

fails=0
# check <name> <command...>: passes when the command succeeds
check() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "ok    $name"; else echo "FAIL  $name"; fails=$((fails + 1)); fi
}
not() { ! "$@"; }

# Paths as sessions record them: C:/... in Git Bash
root=$tmp; [ $windows = 0 ] || root=$(cygpath -m "$tmp")
mkdir -p "$HOME" "$tmp/my-repo" "$tmp/new-repo" "$claude_dir/sessions"
dir=$base/$(enc "$root/my-repo") old=$base/$(enc "$root/old-repo") new=$base/$(enc "$root/new-repo")
mkdir -p "$dir" "$old/memory"

# session <id> <cwd> [folder]: a session file with a prompt and a reply, both recording cwd
session() {
  local cwd; cwd=$(json_path "$2")
  printf '%s\n' "{\"type\":\"user\",\"message\":{\"content\":\"hello\"},\"cwd\":\"$cwd\",\"sessionId\":\"$1\"}" \
    "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\"},\"cwd\":\"$cwd\",\"sessionId\":\"$1\"}" > "${3:-$dir}/$1.jsonl"
}
# a: recorded in my_repo, which shares the folder name but no longer exists (GONE)
a=aaaaaaaa-1111-4111-8111-111111111111; session $a "$root/my_repo"
# b: running, as this shell (Git Bash: its Windows process ID)
b=bbbbbbbb-2222-4222-8222-222222222222; session $b "$root/my-repo"
pid=$$; [ $windows = 0 ] || pid=$(cat /proc/$$/winpid)
printf '{"pid":%s,"sessionId":"%s"}\n' "$pid" "$b" > "$claude_dir/sessions/$pid.json"
# c: recorded in old-repo and its sub folder, then old-repo was renamed to new-repo (LOST)
c=cccccccc-3333-4333-8333-333333333333; session $c "$root/old-repo" "$old"
printf '%s\n' "{\"type\":\"user\",\"message\":{\"content\":\"more\"},\"cwd\":\"$(json_path "$root/old-repo/sub")\",\"sessionId\":\"$c\"}" >> "$old/$c.jsonl"
echo "- a note" > "$old/memory/MEMORY.md"

report=$("$repo/bin/claude-check-cwd.sh")
check "check-cwd reports a as GONE" grep -q '^aaaaaaaa  *GONE' <<<"$report"
check "check-cwd reports c as LOST" grep -q '^cccccccc  *LOST' <<<"$report"
"$repo/bin/claude-check-cwd.sh" -m rewrite --go >/dev/null
check "rewrite sets a's cwd to the real path" test "$(first_cwd "$dir/$a.jsonl")" = "$root/my-repo"
check "rewrite changes every cwd in a" not grep -q 'my_repo' "$dir/$a.jsonl"
check "rewrite backs up a as it was" grep -q 'my_repo' "$HOME/claude-cwd-backup/${dir##*/}/$a.jsonl"

check "rewrite --to refuses a -p matching several folders" \
  not "$repo/bin/claude-check-cwd.sh" -m rewrite -p repo --to "$tmp/new-repo" --go
"$repo/bin/claude-check-cwd.sh" -m rewrite -p old-repo --to "$tmp/new-repo" --go >/dev/null
check "rewrite --to moves c to the new path's folder" test "$(first_cwd "$new/$c.jsonl")" = "$root/new-repo"
check "rewrite --to changes c's sub folder cwd" grep -qF "$(json_path "$root/new-repo/sub")\"" "$new/$c.jsonl"
check "rewrite --to moves memory/ along" test -f "$new/memory/MEMORY.md"

short=$("$repo/bin/claude-short-sessions.sh")
check "short-sessions lists a" grep -qx aaaaaaaa <<<"$short"
check "short-sessions leaves out running b" not grep -q bbbbbbbb <<<"$short"

"$repo/bin/claude-prune.sh" aaaaaaaa >/dev/null
check "prune without --go deletes nothing" test -f "$dir/$a.jsonl"
"$repo/bin/claude-prune.sh" --go bbbbbbbb >/dev/null
check "prune --go skips running b" test -f "$dir/$b.jsonl"
"$repo/bin/claude-prune.sh" --go aaaaaaaa >/dev/null
check "prune --go deletes a" not test -e "$dir/$a.jsonl"

[ $fails = 0 ]
