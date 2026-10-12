#!/usr/bin/env bash
# claude-prune.sh ID [ID...]          -> dry run
# claude-prune.sh --go ID [ID...]     -> delete
# An ID is a session ID or its first 8 or more characters. Running sessions are skipped.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

go=0; [ "$1" = "--go" ] && { go=1; shift; }
[ $# -eq 0 ] && { echo "usage: $(basename "$0") [--go] ID [ID...]" >&2; exit 1; }
live=$(live_sessions)
rc=0

for id in "$@"; do
  if [[ ! $id =~ ^[0-9a-f]{8}[0-9a-f-]*$ ]]; then echo "BAD ID (need 8+ characters of a session ID): '$id'" >&2; rc=1; continue; fi
  if in_list "$id" "$live"; then echo "SKIP (running): $id"; continue; fi
  files=()
  for f in "$base"/*/"$id"*.jsonl; do [ -e "$f" ] && files+=("$f"); done
  if [ ${#files[@]} -eq 0 ]; then echo "NOT FOUND: $id"; continue; fi
  if [ ${#files[@]} -gt 1 ]; then echo "AMBIGUOUS: $id matches ${#files[@]} sessions; give more characters" >&2; rc=1; continue; fi
  f=${files[0]}; d="${f%.jsonl}"
  echo "DELETE $f"; [ -d "$d" ] && echo "DELETE $d/"
  if [ $go -eq 1 ]; then rm -v -- "$f"; [ -d "$d" ] && rm -rv -- "$d"; fi
done
if [ $go -eq 0 ]; then echo "(dry run: nothing deleted, add --go to delete)"; fi
exit $rc
