#!/usr/bin/env bash
# claude-sessions.sh: per-session listing with ID first, right-aligned SIZE, PROMPTS and REPLIES.
# Prompts are the messages you typed; replies are model responses (one prompt gets several while Claude works).
# On a terminal narrower than the table, lines are cut at its width; pipe to less -S to scroll.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

for f in "$base"/*/*.jsonl; do
  [ -e "$f" ] || continue
  session_stats "$f"
  session_row "$f"
done | session_table
