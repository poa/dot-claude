#!/usr/bin/env bash
# claude-keepalive-report.sh
# Weigh what the usage-footer keep-alive pings cost on the plan's meters against the cache
# rebuilds they avoid, from the log its logUsage option writes. Read-only.
. "$(dirname "$(readlink -f "$0")")/../lib/sessions.sh"

logs=$claude_dir/logs/usage
since=""
whatif=0
ttl=60
lead=5
from=07:00
until=20:00
days=Mon-Fri
offset=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Weigh what the usage-footer keep-alive costs on the plan's usage meters
against what it saves. Reads the log usage-footer writes with its logUsage
option on: one line per request, ping and compaction, with the 5-hour and
7-day meters.

Prints one "name<TAB>value" row per figure; costs are in % of a meter (_5h,
_7d), or in thousands of input-token equivalents at API prices (_keq) while
the log has no meter readings. The main ones:
  write_read_ratio    a written token's cost in read tokens (API prices: 20); "-"
                      when the fit can't tell the read price from zero
  rebuilds_avoided    returns to a warm cache after the cache lifetime
  ping_net_5h         those rebuilds minus all pings: above 0, pings pay off

With --whatif, replays the gaps between requests in your transcripts for
idle-ping limits 0-6 and prints "limit<TAB>gaps pinged<TAB>pings<TAB>rebuilds
avoided<TAB>net" rows (limit 0 is keep-alive off); stderr says the unit.

Options:
  -d, --dir DIR         Usage log directory (default: $logs)
  -s, --since DATE      Only from DATE on (YYYY-MM-DD, local time)
  -w, --whatif          Replay the transcripts in $base
      --ttl MIN         Cache lifetime in minutes (default: $ttl)
      --lead MIN        Minutes before expiry a ping goes out (default: $lead)
      --from HH:MM      Work hours start, for --whatif (default: $from)
      --until HH:MM     Work hours end (default: $until)
      --days DAYS       Work days, as in keepAliveDays (default: $days)
      --utc-offset OFF  UTC offset of the work hours (default: the system's)
  -h, --help            Show this help

Examples:
  $(basename "$0")                # everything logged so far
  $(basename "$0") -s 2026-10-19  # from one day on
  $(basename "$0") -w             # best maxIdlePings for your gaps
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir)     need "$@"; logs="$2"; shift 2 ;;
    -s|--since)   need "$@"; since="$2"; shift 2 ;;
    -w|--whatif)  whatif=1; shift ;;
    --ttl)        need "$@"; ttl="$2"; shift 2 ;;
    --lead)       need "$@"; lead="$2"; shift 2 ;;
    --from)       need "$@"; from="$2"; shift 2 ;;
    --until)      need "$@"; until="$2"; shift 2 ;;
    --days)       need "$@"; days="$2"; shift 2 ;;
    --utc-offset) need "$@"; offset="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

fail() { echo "Error: $*" >&2; exit 1; }

case "$ttl/$lead" in
  */|/*|*[!0-9/]*) fail "--ttl and --lead must be whole minutes" ;;
esac
[ "$lead" -gt 0 ] && [ "$lead" -lt "$ttl" ] || fail "--lead must be at least 1 and less than --ttl"

# hm HH:MM: minutes since midnight
hm() {
  [[ $1 =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]] || fail "not a time (HH:MM): $1"
  echo $((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
}

# utc_offset [+-HH:MM]: seconds east of UTC; the system's offset when empty
utc_offset() {
  local z=${1:-$(date +%z)} s
  [[ $z =~ ^([+-])([01][0-9]):?([0-5][0-9])$ ]] || fail "not a UTC offset (+07:00): $1"
  s=$(( (10#${BASH_REMATCH[2]} * 60 + 10#${BASH_REMATCH[3]}) * 60 ))
  [ "${BASH_REMATCH[1]}" = - ] && s=$((-s))
  echo "$s"
}

# day_no NAME: 0 for Sunday to 6 for Saturday, from the first 3 letters; -1 when unknown
day_no() {
  local s=${1,,} i names=(sun mon tue wed thu fri sat)
  s=${s// /}
  for i in 0 1 2 3 4 5 6; do [ "${names[i]}" = "${s:0:3}" ] && { echo "$i"; return; }; done
  echo -1
}

# day_flags DAYS: "Mon-Fri", "Mon,Wed,Fri" or "Fri-Mon" as 7 flags from Sunday on (0111110)
day_flags() {
  local flags=(0 0 0 0 0 0 0) part first last d
  local IFS=,
  for part in $1; do
    first=$(day_no "${part%%-*}")
    last=$first
    if [[ $part == *-* ]]; then
      [[ ${part#*-} == *-* ]] && fail "not a list of days: $1"
      last=$(day_no "${part#*-}")
    fi
    [ "$first" -ge 0 ] && [ "$last" -ge 0 ] || fail "not a list of days: $1"
    d=$first
    while :; do
      flags[d]=1
      [ "$d" -eq "$last" ] && break
      d=$(((d + 1) % 7))
    done
  done
  [[ ${flags[*]} == *1* ]] || fail "not a list of days: $1"
  printf '%s' "${flags[@]}"
}

from_min=$(hm "$from") || exit 1
until_min=$(hm "$until") || exit 1
off_s=$(utc_offset "$offset") || exit 1
flags=$(day_flags "$days") || exit 1
since_ms=0
if [ -n "$since" ]; then
  s=$(date -d "$since" +%s 2>/dev/null) || fail "not a date: $since"
  since_ms=$((s * 1000))
fi

# API input price per model family, relative; tokens of other models count in the main model's
# units (base: its price, 0 when unknown)
PRICE='
function price(m) { return m ~ /opus/ ? 5 : m ~ /sonnet/ ? 3 : m ~ /haiku/ ? 1 : 0 }
function fac(m) { return (base && price(m)) ? price(m) / base : 1 }
function cost(rr, nn, oo, s) { return s * (wr * rr + wn * nn + wo * oo) / 1e6 }'

# The usage log as time-ordered rows: t kind session agent model read write input output
# h5 h5Reset d7 d7Reset outcome trigger (resets in epoch seconds); unreadable lines are skipped
log_rows() {
  local files=("$logs"/*.jsonl)
  [ -e "${files[0]}" ] || return 0
  jq -rR --argjson since "$since_ms" '
    def epoch: if type == "string" then (try (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) catch "") else "" end;
    fromjson? | select(type == "object" and (.t | type) == "number" and .t >= $since)
    | [.t, .kind, .session, (if .agent then 1 else 0 end), (.model // ""),
       (.read // 0), (.write // 0), (.input // 0), (.output // 0),
       (.h5 // ""), (.h5Reset | epoch), (.d7 // ""), (.d7Reset | epoch), (.outcome // ""), (.trigger // "")]
    | @tsv' "${files[@]}" | sort -t$'\t' -k1,1n
}

# The meter fit, one row: kind (weights, api-ratios or none), windows for 5h and 7d, the weights
# wr wn wo of a read, newly cached (written or uncached) and output token per million, the
# meters' scales s5 s7 (% per weighted million tokens), the main model's price and whether the
# read weight is clearly above zero (1/0).
#
# Hourly windows over all sessions, inside one meter window (same reset at both ends): the
# meter's rise across each against the tokens in it. "weights": least squares on the 5-hour
# rises, from 10 windows on and only when every weight comes out positive; else API price
# ratios (read 0.1, written 2, output 5, the 1-hour cache), scaled so the sums match.
fit() {
  awk -F'\t' "$PRICE"'
    { n++; t[n] = $1; model[n] = $5; r[n] = $6; w[n] = $7 + $8; o[n] = $9
      h5[n] = $10; h5r[n] = $11; d7[n] = $12; d7r[n] = $13
      if ($2 == "request" && !$4) main[$5]++ }
    function det(a, b, c, d, e, f, g, h, i) { return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) }
    function close_window(m, su, sr, lu, lr, xr, xn, xo,   k) {
      if (su == "" || lu == "" || xr + xn + xo == 0 || lu - su < 0) return
      if ((sr == "") != (lr == "") || sr - lr > 120 || lr - sr > 120) return
      k = ++NW[m]; WR[m, k] = xr; WN[m, k] = xn; WO[m, k] = xo; WD[m, k] = lu - su
    }
    function windows(m, used, reset,   i, hour, cur, su, sr, lu, lr, pu, pr, xr, xn, xo) {
      cur = -1; pu = ""; pr = ""
      for (i = 1; i <= n; i++) {
        hour = int(t[i] / 3600000)
        if (hour != cur) {
          if (cur >= 0) close_window(m, su, sr, lu, lr, xr, xn, xo)
          cur = hour; su = pu; sr = pr; lu = ""; lr = ""; xr = xn = xo = 0
        }
        xr += r[i] * f[i] / 1e6; xn += w[i] * f[i] / 1e6; xo += o[i] * f[i] / 1e6
        if (used[i] != "") { lu = pu = used[i]; lr = pr = reset[i] }
      }
      if (cur >= 0) close_window(m, su, sr, lu, lr, xr, xn, xo)
    }
    function scale(m,   k, up, down) {
      for (k = 1; k <= NW[m]; k++) { up += WD[m, k]; down += wr * WR[m, k] + wn * WN[m, k] + wo * WO[m, k] }
      return down > 0 ? up / down : 0
    }
    END {
      for (mm in main) if (main[mm] > best) { best = main[mm]; base = price(mm) }
      for (i = 1; i <= n; i++) f[i] = fac(model[i])
      NW[5] = NW[7] = 0
      windows(5, h5, h5r); windows(7, d7, d7r)
      for (k = 1; k <= NW[5]; k++) {
        x1 = WR[5, k]; x2 = WN[5, k]; x3 = WO[5, k]; y = WD[5, k]
        a11 += x1 * x1; a12 += x1 * x2; a13 += x1 * x3; a22 += x2 * x2; a23 += x2 * x3; a33 += x3 * x3
        b1 += x1 * y; b2 += x2 * y; b3 += x3 * y
      }
      kind = "api-ratios"
      dt = det(a11, a12, a13, a12, a22, a23, a13, a23, a33)
      if (NW[5] >= 10 && dt > 0) {
        wr = det(b1, a12, a13, b2, a22, a23, b3, a23, a33) / dt
        wn = det(a11, b1, a13, a12, b2, a23, a13, b3, a33) / dt
        wo = det(a11, a12, b1, a12, a22, b2, a13, a23, b3) / dt
        if (wr > 0 && wn > 0 && wo > 0) kind = "weights"
      }
      if (kind != "weights") { wr = 0.1; wn = 2; wo = 5 }
      # the read weight must beat twice its standard error, else written / read is noise
      sure = 1
      if (kind == "weights") {
        for (k = 1; k <= NW[5]; k++) { e = WD[5, k] - wr * WR[5, k] - wn * WN[5, k] - wo * WO[5, k]; rss += e * e }
        sure = wr > 2 * sqrt(rss / (NW[5] - 3) * (a22 * a33 - a23 * a23) / dt)
      }
      s5 = scale(5); s7 = scale(7)
      if (s5 == 0) { kind = "none"; s5 = 1000; s7 = 0 }
      printf "%s\t%d\t%d\t%.6g\t%.6g\t%.6g\t%.6g\t%.6g\t%s\t%d\n", kind, NW[5], NW[7], wr, wn, wo, s5, s7, base + 0, sure
    }'
}

# The ledger: per session, each main request R against the previous one P. Pings between them
# cost what they read; a warm R at least a cache lifetime after P is a rebuild avoided (its
# history written instead of read), a cold one or a keep-alive compaction between them makes
# the pings wasted. A keep-alive compaction is weighed against R alone: rebuilding P's history
# against what R cost; the smaller history of later requests isn't counted.
ledger() {
  awk -F'\t' -v kind="$1" -v nw5="$2" -v nw7="$3" -v wr="$4" -v wn="$5" -v wo="$6" -v s5="$7" -v s7="$8" -v base="$9" -v sure="${10}" \
    -v ttl_ms=$((ttl * 60000)) "$PRICE"'
    {
      ses = $3; f = fac($5); rr = $6 * f; nn = ($7 + $8) * f; oo = $9 * f
      used5 += cost(rr, nn, oo, s5); used7 += cost(rr, nn, oo, s7)
      if ($2 == "ping") {
        if (rr + nn + oo == 0) { failed++; next }
        pn[ses]++; p5[ses] += cost(rr, nn, oo, s5); p7[ses] += cost(rr, nn, oo, s7)
        next
      }
      if ($2 == "compact") {
        if ($15 == "keepalive") { kc[ses] = 1; c5[ses] += cost(rr, nn, oo, s5); c7[ses] += cost(rr, nn, oo, s7) }
        next
      }
      if ($2 != "request") next
      if ($4) { agent_requests++; next }
      requests++
      warm = $6 >= $7 + $8
      if (ses in prev) {
        gap = $1 - prev[ses]
        if (pn[ses]) {
          pings += pn[ses]; ping5 += p5[ses]; ping7 += p7[ses]
          if (kc[ses] || !warm) wasted++
          else if (gap >= ttl_ms) { avoided++; save5 += cost(0, rr, 0, s5) - cost(rr, 0, 0, s5); save7 += cost(0, rr, 0, s7) - cost(rr, 0, 0, s7) }
          else unneeded++
        } else if (!kc[ses] && !warm && gap >= ttl_ms) cold++
        if (kc[ses]) {
          compactions++; comp5 += c5[ses]; comp7 += c7[ses]
          rebuild = gap >= ttl_ms
          first5 += cost(rebuild ? 0 : ctx[ses], rebuild ? ctx[ses] : 0, 0, s5) - cost(rr, nn, 0, s5)
          first7 += cost(rebuild ? 0 : ctx[ses], rebuild ? ctx[ses] : 0, 0, s7) - cost(rr, nn, 0, s7)
        }
      }
      prev[ses] = $1; ctx[ses] = rr + nn
      pn[ses] = p5[ses] = p7[ses] = kc[ses] = c5[ses] = c7[ses] = 0
    }
    function row(name, value) { printf "%s\t%s\n", name, value }
    function money(name, v5, v7) {
      row(name "_" (kind == "none" ? "keq" : "5h"), sprintf("%.2f", v5))
      if (s7 > 0) row(name "_7d", sprintf("%.2f", v7))
    }
    END {
      for (ses in pn) if (pn[ses]) { open++; pings += pn[ses]; ping5 += p5[ses]; ping7 += p7[ses] }
      for (ses in kc) if (kc[ses]) { compactions++; comp5 += c5[ses]; comp7 += c7[ses] }
      row("fit", kind); row("fit_windows_5h", nw5); row("fit_windows_7d", nw7)
      money("read_per_M", s5 * wr, s7 * wr); money("written_per_M", s5 * wn, s7 * wn); money("output_per_M", s5 * wo, s7 * wo)
      row("write_read_ratio", sure ? sprintf("%.1f", wn / wr) : "-")
      row("requests", requests + 0); row("agent_requests", agent_requests + 0)
      row("pings", pings + 0); row("pings_failed", failed + 0)
      row("rebuilds_avoided", avoided + 0); row("chains_wasted", wasted + 0)
      row("pings_unneeded", unneeded + 0); row("chains_open", open + 0); row("cold_starts", cold + 0)
      row("keepalive_compactions", compactions + 0)
      money("used", used5, used7)
      money("ping_cost", ping5, ping7); money("rebuild_saving", save5, save7)
      money("ping_net", save5 - ping5, save7 - ping7)
      row("ping_net_share", used5 > 0 ? sprintf("%.1f%%", 100 * (save5 - ping5) / used5) : "-")
      money("compaction_cost", comp5, comp7); money("compaction_saving", first5, first7)
    }'
}

# Main-chain requests in the transcripts, one per API request, by session and time:
# session request t read write input model
transcript_rows() {
  local f
  for f in "$base"/*/*.jsonl; do
    [ -e "$f" ] || continue
    jq -rR --argjson since "$since_ms" '
      fromjson? | select(.type == "assistant" and (.isSidechain | not) and .message.usage != null
        and .requestId != null and .message.model != "<synthetic>")
      | ((.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000) as $t
      | select($t >= $since)
      | .message.usage as $u
      | [.sessionId, .requestId, $t, ($u.cache_read_input_tokens // 0), ($u.cache_creation_input_tokens // 0),
         ($u.input_tokens // 0), .message.model]
      | @tsv' "$f"
  done | awk -F'\t' '!seen[$2]++' | sort -t$'\t' -k1,1 -k3,3n
}

# The replay: for each gap between two requests of a session and each idle-ping limit, the pings
# the keep-alive would send (every ttl - lead minutes, in work hours, up to the limit) and
# whether the next request would find the cache warm. Compactions aren't replayed.
whatif_rows() {
  awk -F'\t' -v wr="$1" -v wn="$2" -v wo="$3" -v s5="$4" -v base="$5" \
    -v ttl_ms=$((ttl * 60000)) -v step=$(((ttl - lead) * 60000)) \
    -v off="$off_s" -v from="$from_min" -v until="$until_min" -v flags="$flags" "$PRICE"'
    function workday(d) { return substr(flags, d + 1, 1) == "1" }
    # the hours after midnight of a window across it belong to the day it started
    function inwork(ms,   l, mins, d) {
      l = int(ms / 1000) + off; mins = int((l % 86400) / 60); d = (int(l / 86400) + 4) % 7
      if (from == until) return 0
      if (from < until) return mins >= from && mins < until && workday(d)
      if (mins >= from) return workday(d)
      return mins < until && workday((d + 6) % 7)
    }
    {
      if ($1 == ses) {
        gap = $3 - pt
        for (k = 1; k <= 6; k++) {
          for (n = 0; n < k; n++) { at = pt + step * (n + 1); if (at >= $3 || !inwork(at)) break }
          if (!n) continue
          saved = gap >= ttl_ms && gap < step * n + ttl_ms
          gaps[k]++; pings[k] += n; avoided[k] += saved
          net[k] += saved * (cost(0, pc, 0, s5) - cost(pc, 0, 0, s5)) - n * cost(pc, 0, 0, s5)
        }
      }
      ses = $1; pt = $3; pc = ($4 + $5 + $6) * fac($7)
    }
    END { for (k = 0; k <= 6; k++) printf "%d\t%d\t%d\t%d\t%.2f\n", k, gaps[k], pings[k], avoided[k], net[k] }'
}

IFS=$'\t' read -r kind nw5 nw7 wr wn wo s5 s7 price sure < <(log_rows | fit)

# On a terminal, line the columns up; piped output stays tab-separated
tty=0
[ -t 1 ] && tty=1
tidy() { if [ $tty -eq 1 ] && command -v column >/dev/null; then column -t -s$'\t'; else cat; fi; }

if [ $whatif -eq 1 ]; then
  [ -d "$base" ] || fail "directory not found: $base"
  case $kind in
    weights)    echo "net in % of the 5-hour meter, weights fitted on $nw5 hourly windows of the usage log" >&2 ;;
    api-ratios) echo "net in % of the 5-hour meter, API price ratios scaled on $nw5 hourly windows of the usage log" >&2 ;;
    *)          echo "net in thousands of input-token equivalents at API price ratios (no meter readings in $logs)" >&2 ;;
  esac
  {
    [ $tty -eq 1 ] && printf 'limit\tgaps pinged\tpings\trebuilds avoided\tnet\n'
    transcript_rows | whatif_rows "$wr" "$wn" "$wo" "$s5" "$price"
  } | tidy
  exit 0
fi

[ -n "$(log_rows | head -1)" ] || fail "no usage log in $logs${since:+ since $since}; turn on logUsage in /config (usage-footer)"
log_rows | ledger "$kind" "$nw5" "$nw7" "$wr" "$wn" "$wo" "$s5" "$s7" "$price" "$sure" | tidy
