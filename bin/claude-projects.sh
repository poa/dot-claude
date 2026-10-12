#!/usr/bin/env bash
# Read-only inventory of Claude Code project folders with resolved real paths.
# STATUS: EXISTS, MISSING (the path is gone), UNKNOWN (no path found) or MISNAMED (the folder
# name isn't the one Claude Code uses for the path, so Claude Code never reads this folder).
# On a terminal narrower than the table, lines are cut at its width; pipe to less -S to scroll.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

{
  printf "PROJECT\tSESS\tSIZE_MB\tMEM_F\tLAST ACTIVITY\tSTATUS\tREAL PATH\n"
  for d in "$base"/*/; do
    name=$(basename "$d")
    sess=$(find "$d" -maxdepth 1 -name '*.jsonl' | wc -l)
    size=$(du -sk "$d" | cut -f1)
    memf=$(find "$d/memory" -type f 2>/dev/null | wc -l)
    last=$(find "$d" -type f -printf '%TY-%Tm-%Td %TH:%TM\n' | sort | tail -n1)

    project_path "$d"
    if [ -z "$proj_path" ]; then status=UNKNOWN
    elif [ "$(enc "$proj_path")" != "$name" ]; then status=MISNAMED
    elif [ -d "$proj_path" ]; then status=EXISTS
    else status=MISSING; fi
    shown=-; [ -n "$proj_path" ] && shown="$(tilde "$proj_path") ($proj_src)"

    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$(short "$name")" "$sess" \
      "$(awk "BEGIN{printf \"%.1f\", $size/1024}")" "$memf" "${last:--}" "$status" "$shown"
  done | sort -t$'\t' -k5,5
} | table 2 3 4
