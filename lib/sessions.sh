# Functions and defaults shared by the bin/claude-*.sh scripts. Bash only; the scripts source it.

claude_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
base=$claude_dir/projects

# need "$@": in an option loop, fail unless the option in $1 has a value
need() { [ $# -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }; }

# enc <path>: the project folder name Claude Code uses for a path: every character
# other than a letter or digit becomes "-" (/home/me/my_repo -> -home-me-my-repo)
enc() { printf '%s' "${1//[^A-Za-z0-9]/-}"; }

# short <folder name>: the name without the home folder part (-home-me-git-x -> git-x)
short() { local h; h=$(enc "$HOME"); printf '%s' "${1#"$h"-}"; }

# tilde <path>: the path with the home folder written as ~
tilde() { case $1 in "$HOME" | "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# first_cwd <session file>: the working folder the session started in
first_cwd() { grep -m1 -o '"cwd":"[^"]*"' "$1" | cut -d'"' -f4; }

# decode <folder name>: rebuild the real path by testing the filesystem;
# each "-" in the name may have been "/", "-", "." or "_"
decode() {
  local rest=${1#-} IFS=-
  local -a parts
  read -ra parts <<< "$rest"
  _walk() {
    local path=$1; shift
    if [ $# -eq 0 ]; then [ -d "$path" ] && echo "$path" && return 0 || return 1; fi
    local acc=$1; shift
    # finish this segment here (a "/" boundary) ...
    if [ -e "$path/$acc" ]; then _walk "$path/$acc" "$@" && return 0; fi
    # ... or extend it with -, . or _ plus the next part
    if [ $# -gt 0 ]; then
      local n=$1 s; shift
      for s in - . _; do _walk "$path" "$acc$s$n" "$@" && return 0; done
    fi
    return 1
  }
  [ ${#parts[@]} -gt 0 ] && _walk "" "${parts[@]}"
}

# project_path <folder>: sets proj_path to the folder's real path and proj_src to how it was found:
# cwd (an existing working folder of a session that matches the name) or decoded; else a matching
# working folder that no longer exists (cwd); both empty if not found.
# Different paths can share a name (my_repo and my-repo), so a session's folder alone isn't proof.
project_path() {
  local d=${1%/} f c gone=""
  proj_path=""; proj_src=""
  for f in "$d"/*.jsonl; do
    [ -e "$f" ] || continue
    c=$(first_cwd "$f")
    [ -n "$c" ] && [ "$(enc "$c")" = "${d##*/}" ] || continue
    if [ -d "$c" ]; then proj_path=$c; proj_src=cwd; return 0; fi
    gone=$c
  done
  if proj_path=$(decode "${d##*/}"); then proj_src=decoded
  elif [ -n "$gone" ]; then proj_path=$gone; proj_src=cwd
  fi
  return 0
}

# live_sessions: IDs of the sessions whose Claude Code process is still running, one per line
live_sessions() {
  local f pid
  for f in "$claude_dir"/sessions/*.json; do
    [ -e "$f" ] || continue
    pid=$(basename "$f" .json)
    case $pid in '' | *[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null && jq -r '.sessionId // empty' "$f"
  done
}

# in_list <ID or prefix> <IDs, one per line>: true if one of the IDs starts with the first argument
in_list() { [[ $'\n'$2 == *$'\n'"$1"* ]]; }

# session_stats <session file>: sets
#   prompts  messages you typed (commands, tool results and summaries don't count)
#   replies  model responses; one prompt gets several while Claude works
#   branch   last git branch, or -
#   title    /rename name, else the automatic title, else empty
#   first    first line of the first prompt
session_stats() {
  local d=${1%.jsonl} custom=""
  [ -f "$d/custom-title.json" ] && custom=$(jq -r '.customTitle // empty' "$d/custom-title.json" 2>/dev/null)
  { read -r prompts; read -r replies; read -r branch; read -r title; read -r first; } < <(
    jq -nrR --arg custom "$custom" '
      def text: if type == "string" then .
        else map(select(type == "object" and .type == "text") | .text // "") | join(" ") end;
      def put(k; v): if (v // "") != "" then .[k] = v else . end;
      reduce (inputs | fromjson? | objects) as $e
        ({prompts: 0, ids: {}, branch: "-", custom: $custom, ai: "", first: ""};
         if $e.type == "assistant" then .ids[$e.message.id // "?"] = 1
         elif $e.type == "user" and ($e.isMeta | not) and ($e.isCompactSummary | not) then
           ($e.message.content // "" | text) as $t
           | if $t | test("^\\s*($|<|\\[Request interrupted)") then .
             else .prompts += 1 | if .first == "" then .first = $t else . end end
         else . end
         | put("branch"; $e.gitBranch) | put("ai"; $e.aiTitle)
         | if $custom == "" then put("custom"; $e.customTitle) else . end)
      | .prompts, (.ids | length), .branch,
        (if .custom != "" then .custom else .ai end | gsub("[\\t\\r\\n]"; " ")),
        (.first | split("\n") | .[0] // "" | gsub("[\\t\\r]"; " "))' "$1" 2>/dev/null)
  : "${prompts:=0}" "${replies:=0}" "${branch:=-}"
}

# session_row <session file>: one tab-separated row for session_table; call session_stats on the file first
session_row() {
  local id name
  id=$(basename "$1" .jsonl)
  name=$title; [ -n "$name" ] || name="(prompt) $first"
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "${id:0:8}" "$(stat -c '%y' "$1" | cut -c1-16)" \
    "$(( $(stat -c %s "$1") / 1024 ))KB" "$prompts" "$replies" "$(short "$(basename "$(dirname "$1")")")" \
    "$branch" "${name:0:60}"
}

# session_table: session_row lines from stdin as a table with a header, sorted by project, then time
session_table() {
  { printf "ID\tLAST MODIFIED\tSIZE\tPROMPTS\tREPLIES\tPROJECT\tBRANCH\tNAME\n"; sort -t$'\t' -k6,6 -k2,2; } | table 3 4 5
}

# table [N...]: align tab-separated lines into columns, right-aligning columns N...; the last column isn't padded
table() {
  awk -F'\t' -v right="$*" '
    BEGIN { split(right, r, " "); for (i in r) ra[r[i]] = 1 }
    { for (i = 1; i <= NF; i++) { c[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) }
      if (NF > nf) nf = NF }
    END {
      for (row = 1; row <= NR; row++) {
        line = ""
        for (i = 1; i <= nf; i++) {
          if (i in ra)      cell = sprintf("%" w[i] "s", c[row, i])
          else if (i == nf) cell = c[row, i]
          else              cell = sprintf("%-" w[i] "s", c[row, i])
          line = line cell (i < nf ? "  " : "")
        }
        print line
      }
    }' | fit
}

# fit: on a terminal, cut lines longer than its width instead of wrapping them; shorter lines and
# piped output stay as they are (| less -S to scroll)
# (The width comes from the terminal on stdout: in a pipeline tput sees no terminal and falls back to 80.)
fit() {
  local w=0
  if [ -t 1 ]; then { w=$(stty size <&3 2>/dev/null); } 3>&1; w=${w#* }; fi
  if [ "${w:-0}" -gt 0 ] 2>/dev/null; then awk -v w="$w" '{ print substr($0, 1, w) }'; else cat; fi
}
