#!/usr/bin/env bash
# claude-short-sessions.sh
# List Claude Code sessions with few replies. Read-only.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

max=3
project=""
verbose=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

List Claude Code sessions that have at most N replies (model responses; one
prompt gets several while Claude works), typically accidental starts and
quick tests like "ls" or "echo hello".
By default prints one 8-character session ID per line.
Running sessions are left out.

Options:
  -n, --max N         Maximum number of replies (default: $max)
  -p, --project STR   Only projects whose folder name contains STR
                      (example: -p my-project)
  -d, --dir DIR       Projects directory (default: $base)
  -v, --verbose       Print the table claude-sessions.sh prints, for these sessions
  -h, --help          Show this help

Examples:
  $(basename "$0")                       # IDs of sessions with <= 3 replies
  $(basename "$0") -n 0                  # sessions with no reply
  $(basename "$0") -p my-project -v      # table for one project
  $(basename "$0") -n 5 | xargs -r claude-prune.sh        # dry run of delete
  $(basename "$0") -n 5 | xargs -r claude-prune.sh --go   # actually delete

Note: named sessions (/rename) are also listed if they are short.
Check -v output before deleting.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--max)     need "$@"; max="$2"; shift 2 ;;
    -p|--project) need "$@"; project="$2"; shift 2 ;;
    -d|--dir)     need "$@"; base="$2"; shift 2 ;;
    -v|--verbose) verbose=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$max" in
  ''|*[!0-9]*) echo "Error: --max must be a non-negative integer" >&2; exit 1 ;;
esac
[ -d "$base" ] || { echo "Error: directory not found: $base" >&2; exit 1; }
live=$(live_sessions)

for f in "$base"/*/*.jsonl; do
  [ -e "$f" ] || continue
  proj=$(basename "$(dirname "$f")")
  [ -n "$project" ] && [[ "$proj" != *"$project"* ]] && continue
  id=$(basename "$f" .jsonl)
  in_list "$id" "$live" && continue

  session_stats "$f"
  [ "$replies" -le "$max" ] || continue

  if [ $verbose -eq 1 ]; then session_row "$f"; else echo "${id:0:8}"; fi
done | if [ $verbose -eq 1 ]; then session_table; else cat; fi
