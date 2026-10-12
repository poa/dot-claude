#!/usr/bin/env bash
# claude-check-cwd.sh
# Check that each session's recorded cwd matches the project folder it lives in.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

backup="$HOME/claude-cwd-backup"
mode="report"
go=0
filter=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Reports sessions whose first recorded cwd does not match their project folder
(MISMATCH) or no longer exists while the project's real path does (GONE, e.g.
after renaming my_repo to my-repo, which share a folder name), and project
folders whose name is not the one Claude Code uses for their path
(MISNAMED: Claude Code never reads them).
Dry run unless --go is given.

Options:
  -m, --mode MODE     report (default) | rewrite | move
                        rewrite: change the cwd inside the session to the
                                 project folder's real path
                        move:    move the session into the project folder
                                 that matches its cwd
  -p, --project STR   Only project folders whose name contains STR
  -d, --dir DIR       Projects directory (default: $base)
      --go            Apply changes (otherwise only print what would happen)
  -h, --help          Show this help

Backups of changed/moved files go to: $backup
Running sessions are skipped; still, close Claude sessions before using --go.

Examples:
  $(basename "$0")                              # report only
  $(basename "$0") -m rewrite                   # dry run of cwd rewrite
  $(basename "$0") -m rewrite -p my-project --go
  $(basename "$0") -m move --go
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--mode)    need "$@"; mode="$2"; shift 2 ;;
    -p|--project) need "$@"; filter="$2"; shift 2 ;;
    -d|--dir)     need "$@"; base="$2"; shift 2 ;;
    --go)         go=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done
case "$mode" in report|rewrite|move) ;; *) echo "Bad mode: $mode" >&2; exit 1 ;; esac
[ -d "$base" ] || { echo "Directory not found: $base" >&2; exit 1; }
[ "$mode" != rewrite ] || command -v perl >/dev/null || { echo "perl is required" >&2; exit 1; }
live=$(live_sessions)

row() { printf "%-9s %-8s %-38s %s\n" "$@"; }
ok=0; bad=0; gone=0; misnamed=0; fixed=0; skipped=0; nocwd=0
row "ID" "STATUS" "RECORDED CWD" "PROJECT FOLDER -> EXPECTED PATH"

for d in "$base"/*/; do
  name=$(basename "$d")
  [ -n "$filter" ] && [[ "$name" != *"$filter"* ]] && continue
  project_path "$d"; pp=$proj_path
  if [ -n "$pp" ] && [ "$(enc "$pp")" != "$name" ]; then
    misnamed=$((misnamed+1))
    row "-" "MISNAMED" "-" "$(short "$name") -> $(short "$(enc "$pp")")"
  fi

  for f in "$d"*.jsonl; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .jsonl); sid=${id:0:8}
    fc=$(first_cwd "$f")
    if [ -z "$fc" ]; then nocwd=$((nocwd+1)); row "$sid" "NO-CWD" "-" "$(short "$name")"; continue; fi
    if [ "$(enc "$fc")" != "$name" ]; then status=MISMATCH; bad=$((bad+1))
    elif [ ! -d "$fc" ] && [ -d "$pp" ] && [ "$fc" != "$pp" ]; then status=GONE; gone=$((gone+1))
    else ok=$((ok+1)); continue; fi

    shown=$(tilde "$fc"); [ ${#shown} -le 38 ] || shown=${shown: -38}
    row "$sid" "$status" "$shown" "$(short "$name") -> ${pp:-UNKNOWN}"
    [ "$mode" = "report" ] && continue
    if in_list "$id" "$live"; then echo "    skip: the session is running"; skipped=$((skipped+1)); continue; fi

    if [ "$mode" = "rewrite" ]; then
      if [ -z "$pp" ]; then echo "    skip: cannot determine this project's real path"; skipped=$((skipped+1)); continue; fi
      if [ "$(enc "$pp")" != "$name" ]; then echo "    skip: the folder is misnamed; use -m move"; skipped=$((skipped+1)); continue; fi
      echo "    rewrite cwd: $fc -> $pp"
      if [ $go -eq 1 ]; then
        mkdir -p "$backup/$name"; cp -p -- "$f" "$backup/$name/"
        OLD="$fc" NEW="$pp" perl -pi -e 's#"cwd":"\Q$ENV{OLD}\E(?=["/])#"cwd":"$ENV{NEW}#g' "$f"
        touch -r "$backup/$name/$(basename "$f")" "$f"      # keep the original modified time
        if [ "$(first_cwd "$f")" = "$pp" ]; then fixed=$((fixed+1)); else echo "    WARNING: still inconsistent"; fi
      fi
    else  # move
      if [ ! -d "$fc" ]; then echo "    skip: $fc does not exist on disk; use -m rewrite"; skipped=$((skipped+1)); continue; fi
      tdir="$base/$(enc "$fc")"
      if [ -e "$tdir/$id.jsonl" ] || [ -e "$tdir/$id" ]; then echo "    skip: $tdir/ already has this session"; skipped=$((skipped+1)); continue; fi
      echo "    move to: $tdir/"
      if [ $go -eq 1 ]; then
        mkdir -p "$backup/$name" "$tdir"; cp -p -- "$f" "$backup/$name/"
        mv -- "$f" "$tdir/"
        [ -d "$d$id" ] && mv -- "$d$id" "$tdir/"
        fixed=$((fixed+1))
      fi
    fi
  done
done

echo
echo "consistent: $ok  mismatched: $bad  gone: $gone  misnamed folders: $misnamed  no-cwd: $nocwd  fixed: $fixed  skipped: $skipped"
if [ $misnamed -gt 0 ]; then echo "Misnamed folders: move their sessions with -m move, then their memory/ by hand."; fi
if [ "$mode" != "report" ] && [ $go -eq 0 ]; then echo "(dry run: nothing changed, add --go to apply)"; fi
