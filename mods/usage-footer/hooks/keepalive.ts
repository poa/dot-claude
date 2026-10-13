// Pure keep-alive / compaction logic, kept apart from the hooks so it can be unit-tested.

export const MINUTE_MS = 60_000
// Act when the cache has at most this much lifetime left; leaves room for the request to start.
export const MAX_LEAD_MS = 5 * MINUTE_MS

// How long before expiry to act: 5 min, or half the lifetime when that is shorter,
// so a short test lifetime does not put every tick inside the window.
export const leadMs = (ttlMs: number) => Math.min(MAX_LEAD_MS, ttlMs / 2)

// "HH:MM" -> minutes since midnight; undefined when malformed.
export function parseHHMM(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m || !m[1] || !m[2]) {
    return undefined
  }
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}

// "+07:00" / "-05:30" -> minutes east of UTC; undefined when empty, malformed or outside -12:00..+14:00.
export function parseUtcOffset(text: string): number | undefined {
  const m = /^([+-])(\d{1,2}):?(\d{2})$/.exec(text.trim())
  if (!m || !m[1] || !m[2] || !m[3]) {
    return undefined
  }
  const mins = Number(m[3])
  const total = Number(m[2]) * 60 + mins
  const minutes = m[1] === '-' ? -total : total
  return mins < 60 && minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : undefined
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// "Mon-Fri", "Mon,Wed,Fri", "Fri-Mon" (wraps) -> day numbers, 0 = Sunday; undefined when malformed.
export function parseDays(text: string): number[] | undefined {
  const days = new Set<number>()
  for (const part of text.toLowerCase().split(',')) {
    const [first, last, ...rest] = part.split('-').map(s => DAY_NAMES.indexOf(s.trim().slice(0, 3)))
    if (first === undefined || first < 0 || (last !== undefined && last < 0) || rest.length > 0) {
      return undefined
    }
    for (let d = first; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === (last ?? first)) {
        break
      }
    }
  }
  return [...days].sort((a, b) => a - b)
}

// Local minutes since midnight: from an explicit UTC offset, else the runtime's own timezone.
export function localMinutes(now: number, offsetMinutes: number | undefined): number {
  if (offsetMinutes === undefined) {
    const d = new Date(now)
    return d.getHours() * 60 + d.getMinutes()
  }
  const total = Math.floor(now / MINUTE_MS) + offsetMinutes
  return ((total % 1440) + 1440) % 1440
}

// Local day of the week, 0 = Sunday, by the same rule as localMinutes.
export function localDay(now: number, offsetMinutes: number | undefined): number {
  return offsetMinutes === undefined ? new Date(now).getDay() : new Date(now + offsetMinutes * MINUTE_MS).getUTCDay()
}

// Whether `minutes` lies in [from, until); a window that wraps midnight is allowed, and from == until is empty.
export function inWindow(minutes: number, from: number, until: number): boolean {
  return from <= until ? minutes >= from && minutes < until : minutes >= from || minutes < until
}

export type WorkTime = {
  fromMinutes: number
  untilMinutes: number
  days: readonly number[]
  utcOffsetMinutes: number | undefined
}

// Inside work hours on a work day. The hours after midnight of a window that wraps
// midnight belong to the day the window started.
export function inWorkTime(now: number, w: WorkTime): boolean {
  const minutes = localMinutes(now, w.utcOffsetMinutes)
  if (!inWindow(minutes, w.fromMinutes, w.untilMinutes)) {
    return false
  }
  const startedYesterday = w.fromMinutes > w.untilMinutes && minutes < w.untilMinutes
  return w.days.includes((localDay(now, w.utcOffsetMinutes) + (startedYesterday ? 6 : 0)) % 7)
}

export type PlanInput = {
  inWorkHours: boolean
  // Pings since the user's last message or the last compaction.
  keepAlives: number
  // 0 = no limit.
  maxIdlePings: number
  lastHumanAt: number | null
  compactedAt: number | null
  // Set when a compaction found the cache cold: no more automatic ones in this session.
  compactCold: boolean
  // The context in use; undefined before the first response.
  contextTokens: number | undefined
  minCompactTokens: number
}

export type DecideInput = PlanInput & {
  now: number
  lastRequestAt: number | null
  ttlMs: number
  busy: boolean
  // Set after a cold ping or repeated failed ones; cleared by the user's next message.
  paused: boolean
}

export type Decision = 'none' | 'ping' | 'compact'

// What to do when the cache is about to expire, timing aside: ping in work hours up to
// the idle cap, then (or after hours) compact once while the cache is still warm.
export function plan(s: PlanInput): Decision {
  if (s.inWorkHours && (s.maxIdlePings === 0 || s.keepAlives < s.maxIdlePings)) {
    return 'ping'
  }
  const humanSinceCompaction = s.compactedAt === null || (s.lastHumanAt !== null && s.lastHumanAt > s.compactedAt)
  const bigEnough = s.contextTokens === undefined || s.contextTokens >= s.minCompactTokens
  return humanSinceCompaction && bigEnough && !s.compactCold ? 'compact' : 'none'
}

export function decide(s: DecideInput): Decision {
  if (s.busy || s.paused || s.lastRequestAt === null) {
    return 'none'
  }
  const leftMs = s.lastRequestAt + s.ttlMs - s.now
  if (leftMs <= 0 || leftMs > leadMs(s.ttlMs)) {
    return 'none'
  }
  return plan(s)
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Input tokens a request was billed for; 0 when no request reached the model.
export const billedInput = (u: Usage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// A warm request reads most of its input from the cache; a cold one writes it again,
// or with prompt caching off sends it all uncached.
export function wasCacheCold(u: Usage): boolean {
  return u.cache_read_input_tokens < u.cache_creation_input_tokens + u.input_tokens
}

// $.model.fork's result, as far as the keep-alive reads it.
export type ForkReply = { isAnswered: true; usage: Usage } | { isAnswered: false; reason: string; usage?: Usage }

export type PingOutcome = 'warm' | 'cold' | 'failed' | 'nothing-to-fork'

// Judged by what was billed, not by the reply: an empty reply still refreshed the cache,
// and an API error that billed nothing did not.
export function pingOutcome(reply: ForkReply): PingOutcome {
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    return 'nothing-to-fork'
  }
  if (reply.usage === undefined || billedInput(reply.usage) === 0) {
    return 'failed'
  }
  return wasCacheCold(reply.usage) ? 'cold' : 'warm'
}
