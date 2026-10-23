#!/usr/bin/env bash
# claude-compare-instructions.sh
# A/B test of instruction sets (a plugin, a rules file) on replayed tasks: runs headless sessions in
# throwaway git worktrees and tabulates cost, tokens, time, diff size and a check result per arm.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

ab_dir=$claude_dir/ab
tasks=$ab_dir/tasks
out=""
arms=base,plugin
runs=3
model=sonnet
effort=high
budget=2
plugin=""
rules=""
mine=""
only=""

usage() {
  cat <<EOF
Usage: $(basename "$0") run [options]
       $(basename "$0") report RUNDIR
       $(basename "$0") blind RUNDIR

run: for every task, every arm, N times (arms in random order), starts
"claude -p" in a fresh git worktree of the task's base commit, with your
CLAUDE.md loaded and auto memory off, then diffs the result against the base
and runs the task's check. Appends one row per session to RUNDIR/results.tsv.

report: per metric and arm, the geometric mean over tasks of the arm's median
divided by the first arm's median, as a change in %, and in how many tasks
the arm was lower. Prints "metric<TAB>arm<TAB>change<TAB>lower in<TAB>tasks"
rows, then "check<TAB>arm<TAB>passed<TAB>sessions<TAB>" rows.

blind: writes the first two arms' median-sized diffs of each task as A.diff and
B.diff under RUNDIR/blind/<task>/, with random labels; the key is
RUNDIR/blind/key.tsv. Read the diffs before opening the key.

Arms: base (nothing added), plugin (--plugin-dir), rules (--append-system-prompt-file
with --rules), mine (the same with --mine).

Task files: TASKS/<name>.task, lines "key=value" then a line "---" then the
prompt. Keys: repo (path of a git repo), base (commit to start from), check
(shell command run in the worktree after the session; exit 0 = pass), allow
(optional extra tools for --allowedTools, e.g. "Bash(npm test:*)").

Options (run):
  -t, --tasks DIR     Task files (default: $(tilde "$tasks"))
  -o, --out DIR       Run folder (default: $(tilde "$ab_dir")/<date>-<time>)
  -a, --arms LIST     Comma-separated arms (default: $arms)
  -n, --runs N        Sessions per task and arm (default: $runs)
  -m, --model M       Model (default: $model)
  -e, --effort E      Effort level (default: $effort)
  -b, --budget USD    Spending cap per session (default: $budget)
      --plugin DIR    Plugin folder for the plugin arm
      --rules FILE    Instructions file for the rules arm
      --mine FILE     Instructions file for the mine arm
      --only NAME     Run only the task NAME
  -h, --help          Show this help

Examples:
  $(basename "$0") run --plugin ~/my-plugin -n 1 --only trivial
  $(basename "$0") report $(tilde "$ab_dir")/2026-10-20-0900
EOF
}

# field <task file> <key>: the value of a key above the "---" line
field() { sed -n '/^---$/q;s/^'"$2"'=//p' "$1" | head -1; }

# run_one <task file> <arm> <n>: one session; appends a row to results.tsv
run_one() {
  local tf=$1 arm=$2 n=$3 name repo rev check allow wt json t0 t1 cost otok turns err added removed files pass args=()
  name=$(basename "$tf" .task)
  repo=$(field "$tf" repo); rev=$(field "$tf" base); check=$(field "$tf" check); allow=$(field "$tf" allow)
  repo=${repo/#\~/$HOME}
  wt=$wtroot/$name.$arm.$n
  json=$out/json/$name.$arm.$n.json
  git -C "$repo" worktree add -q --detach "$wt" "$rev" || { echo "worktree failed: $name" >&2; return 1; }
  case $arm in
    plugin) args+=(--plugin-dir "$plugin") ;;
    rules) args+=(--append-system-prompt-file "$rules") ;;
    mine) args+=(--append-system-prompt-file "$mine") ;;
  esac
  t0=$(date +%s)
  (cd "$wt" && sed '1,/^---$/d' "$tf" | CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p \
    --model "$model" --settings "{\"effortLevel\":\"$effort\"}" --no-session-persistence \
    --output-format json --max-budget-usd "$budget" --permission-mode acceptEdits \
    --allowedTools "Read Grep Glob Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(ls:*) Bash(cat:*) $allow" \
    "${args[@]}" > "$json" 2> "$json.err") || true
  t1=$(date +%s)
  cost=$(jq -r '.total_cost_usd // 0' "$json" 2>/dev/null || echo 0)
  otok=$(jq -r '.usage.output_tokens // 0' "$json" 2>/dev/null || echo 0)
  turns=$(jq -r '.num_turns // 0' "$json" 2>/dev/null || echo 0)
  err=$(jq -r '.is_error' "$json" 2>/dev/null || echo true)
  # lock files only: a bare *lock* would also drop clock.ts or blocks/
  git -C "$wt" add -A -- . ':!*.lock' ':!*-lock.json' ':!*-lock.yaml' ':!*.lockb'
  git -C "$wt" diff --cached "$rev" > "$out/diffs/$name.$arm.$n.diff"
  read -r added removed files < <(git -C "$wt" diff --cached --numstat "$rev" | awk '{a+=$1;r+=$2;f++} END{print a+0,r+0,f+0}')
  if (cd "$wt" && bash -c "$check" > "$out/json/$name.$arm.$n.check" 2>&1); then pass=1; else pass=0; fi
  [ "$err" = false ] || pass=0
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$arm" "$n" "$cost" "$otok" "$turns" "$((t1 - t0))" "$added" "$removed" "$files" "$pass" >> "$out/results.tsv"
  git -C "$repo" worktree remove --force "$wt"
}

do_run() {
  local tf name arm n list
  while [ $# -gt 0 ]; do
    case "$1" in
      -t|--tasks)  need "$@"; tasks="$2"; shift 2 ;;
      -o|--out)    need "$@"; out="$2"; shift 2 ;;
      -a|--arms)   need "$@"; arms="$2"; shift 2 ;;
      -n|--runs)   need "$@"; runs="$2"; shift 2 ;;
      -m|--model)  need "$@"; model="$2"; shift 2 ;;
      -e|--effort) need "$@"; effort="$2"; shift 2 ;;
      -b|--budget) need "$@"; budget="$2"; shift 2 ;;
      --plugin)    need "$@"; plugin="$2"; shift 2 ;;
      --rules)     need "$@"; rules="$2"; shift 2 ;;
      --mine)      need "$@"; mine="$2"; shift 2 ;;
      --only)      need "$@"; only="$2"; shift 2 ;;
      -h|--help)   usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done
  case ,$arms, in *,plugin,*) [ -d "$plugin" ] || { echo "Arm plugin needs --plugin DIR" >&2; exit 1; } ;; esac
  case ,$arms, in *,rules,*) [ -f "$rules" ] || { echo "Arm rules needs --rules FILE" >&2; exit 1; } ;; esac
  case ,$arms, in *,mine,*) [ -f "$mine" ] || { echo "Arm mine needs --mine FILE" >&2; exit 1; } ;; esac
  command -v claude >/dev/null || { echo "claude is needed" >&2; exit 1; }
  [ -n "$out" ] || out=$ab_dir/$(date +%F-%H%M)
  # worktrees stay out of ~/.claude: Claude Code refuses edits there as sensitive
  wtroot=$(mktemp -d)
  trap 'rm -rf "$wtroot"' EXIT
  mkdir -p "$out"/{json,diffs}
  printf 'arms=%s runs=%s model=%s effort=%s\nclaude=%s\n' "$arms" "$runs" "$model" "$effort" "$(claude --version)" > "$out/meta.txt"
  [ -z "$plugin" ] || git -C "$plugin" rev-parse HEAD 2>/dev/null | sed 's/^/plugin=/' >> "$out/meta.txt"
  [ -s "$out/results.tsv" ] || printf 'task\tarm\trun\tcost\tout_tokens\tturns\tseconds\tadded\tremoved\tfiles\tpass\n' > "$out/results.tsv"
  for tf in "$tasks"/*.task; do
    [ -f "$tf" ] || { echo "No tasks in $tasks" >&2; exit 1; }
    name=$(basename "$tf" .task)
    [ -z "$only" ] || [ "$only" = "$name" ] || continue
    for n in $(seq "$runs"); do
      for arm in $(tr , '\n' <<<"$arms" | shuf); do
        # a finished session is not repeated when a run is resumed with --out
        awk -F'\t' -v t="$name" -v a="$arm" -v n="$n" '$1==t&&$2==a&&$3==n{f=1} END{exit !f}' "$out/results.tsv" && continue
        echo "$name $arm $n" >&2
        run_one "$tf" "$arm" "$n" || true
      done
    done
  done
  echo "Results: $(tilde "$out")/results.tsv" >&2
}

# arm_order <run folder>: the arms of the run as listed in --arms, the first one is the baseline.
# (results.tsv lists them in the random order they ran in.)
arm_order() { sed -n '1s/^arms=\([^ ]*\).*/\1/p' "$1/meta.txt" 2>/dev/null; }

do_report() {
  local f=$1/results.tsv
  [ -f "$f" ] || { echo "No $f" >&2; exit 1; }
  awk -F'\t' -v order="$(arm_order "$1")" '
    function med(arr, n,   i, j, t) {
      for (i = 2; i <= n; i++) { t = arr[i]; for (j = i - 1; j >= 1 && arr[j] > t; j--) arr[j + 1] = arr[j]; arr[j + 1] = t }
      return n % 2 ? arr[(n + 1) / 2] : (arr[n / 2] + arr[n / 2 + 1]) / 2
    }
    BEGIN { na = split(order, arms, ","); for (i = 1; i <= na; i++) seenA[arms[i]] = 1 }
    NR == 1 { next }
    {
      k = $1 SUBSEP $2
      if (!($1 in seenT)) { seenT[$1] = 1; tasks[++nt] = $1 }
      if (!($2 in seenA)) { seenA[$2] = 1; arms[++na] = $2 }
      i = ++cnt[k]
      v["cost", k, i] = $4; v["out", k, i] = $5; v["seconds", k, i] = $7; v["lines", k, i] = $8 + $9
      sess[$2]++; pass[$2] += $11
    }
    END {
      split("cost out seconds lines", metrics, " ")
      for (m = 1; m <= 4; m++) for (a = 2; a <= na; a++) {
        sum = 0; used = 0; lower = 0
        for (t = 1; t <= nt; t++) {
          kb = tasks[t] SUBSEP arms[1]; ka = tasks[t] SUBSEP arms[a]
          if (!(kb in cnt) || !(ka in cnt)) continue
          for (i = 1; i <= cnt[kb]; i++) b[i] = v[metrics[m], kb, i]
          for (i = 1; i <= cnt[ka]; i++) x[i] = v[metrics[m], ka, i]
          mb = med(b, cnt[kb]); mx = med(x, cnt[ka])
          if (mb <= 0 || mx <= 0) continue
          sum += log(mx / mb); used++; if (mx < mb) lower++
        }
        if (used) printf "%s\t%s\t%+.0f%%\t%d\t%d\n", metrics[m], arms[a], (exp(sum / used) - 1) * 100, lower, used
      }
      for (a = 1; a <= na; a++) printf "check\t%s\t%d\t%d\t\n", arms[a], pass[arms[a]], sess[arms[a]]
    }' "$f" | fit
}

do_blind() {
  local run=$1 f=$1/results.tsv name a b ra rb fa fb flip
  [ -f "$f" ] || { echo "No $f" >&2; exit 1; }
  a=$(arm_order "$run" | cut -d, -f1); b=$(arm_order "$run" | cut -d, -f2)
  [ -n "$a" ] && [ -n "$b" ] || { echo "Need two arms in $run/meta.txt" >&2; exit 1; }
  mkdir -p "$run/blind"
  printf 'task\tA\tB\n' > "$run/blind/key.tsv"
  for name in $(awk -F'\t' 'NR>1{print $1}' "$f" | sort -u); do
    # the run whose changed-line count is the arm's median (the lower middle one for an even count)
    ra=$(awk -F'\t' -v t="$name" -v a="$a" '$1==t&&$2==a{print $8+$9, $3}' "$f" | sort -n | awk '{r[NR]=$2} END{print r[int((NR+1)/2)]}')
    rb=$(awk -F'\t' -v t="$name" -v a="$b" '$1==t&&$2==a{print $8+$9, $3}' "$f" | sort -n | awk '{r[NR]=$2} END{print r[int((NR+1)/2)]}')
    fa=$run/diffs/$name.$a.$ra.diff; fb=$run/diffs/$name.$b.$rb.diff
    [ -f "$fa" ] && [ -f "$fb" ] || continue
    mkdir -p "$run/blind/$name"
    if [ $((RANDOM % 2)) -eq 0 ]; then
      cp "$fa" "$run/blind/$name/A.diff"; cp "$fb" "$run/blind/$name/B.diff"; flip="$a	$b"
    else
      cp "$fb" "$run/blind/$name/A.diff"; cp "$fa" "$run/blind/$name/B.diff"; flip="$b	$a"
    fi
    printf '%s\t%s\n' "$name" "$flip" >> "$run/blind/key.tsv"
  done
  echo "Diffs: $(tilde "$run")/blind/<task>/{A,B}.diff; key: $(tilde "$run")/blind/key.tsv" >&2
}

cmd=${1:-}
[ $# -eq 0 ] || shift
case "$cmd" in
  run) do_run "$@" ;;
  report) [ $# -eq 1 ] || { usage >&2; exit 1; }; do_report "$1" ;;
  blind) [ $# -eq 1 ] || { usage >&2; exit 1; }; do_blind "$1" ;;
  -h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
