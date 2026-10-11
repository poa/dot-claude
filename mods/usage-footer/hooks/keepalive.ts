// Pure keep-alive / compaction logic, kept apart from the hooks so it can be unit-tested.

export const MINUTE_MS = 60_000
// Act when the cache has this much lifetime left; leaves room for the request to start.
export const ACT_BEFORE_EXPIRY_MS = 5 * MINUTE_MS

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

// "+07:00" / "-05:30" -> minutes east of UTC; undefined when empty or malformed.
export function parseUtcOffset(text: string): number | undefined {
  const m = /^([+-])(\d{1,2}):?(\d{2})$/.exec(text.trim())
  if (!m || !m[1] || !m[2] || !m[3]) {
    return undefined
  }
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
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

// Whether `minutes` lies in [from, until); a window that wraps midnight is allowed.
export function inWindow(minutes: number, from: number, until: number): boolean {
  return from <= until ? minutes >= from && minutes < until : minutes >= from || minutes < until
}

export type DecideInput = {
  now: number
  inWorkHours: boolean
  lastRequestAt: number | null
  ttlMs: number
  busy: boolean
  lastHumanAt: number | null
  compactedAt: number | null
  // Set when a ping found the cache already cold; cleared by the user's next message.
  paused: boolean
}

export type Decision = 'none' | 'ping' | 'compact'

export function decide(s: DecideInput): Decision {
  if (s.busy || s.paused || s.lastRequestAt === null) {
    return 'none'
  }
  const leftMs = s.lastRequestAt + s.ttlMs - s.now
  if (leftMs <= 0 || leftMs > ACT_BEFORE_EXPIRY_MS) {
    return 'none'
  }
  if (s.inWorkHours) {
    return 'ping'
  }
  const humanSinceCompaction = s.compactedAt === null || (s.lastHumanAt !== null && s.lastHumanAt > s.compactedAt)
  return humanSinceCompaction ? 'compact' : 'none'
}

// A warm ping reads the history from cache; a cold one has to write it again.
export function wasCacheCold(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): boolean {
  return usage.cache_creation_input_tokens > usage.cache_read_input_tokens
}
