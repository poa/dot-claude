import { describe, expect, test } from 'claude-code/testing'

import {
  decide,
  inWindow,
  inWorkTime,
  leadMs,
  localDay,
  localMinutes,
  parseDays,
  parseHHMM,
  parseUtcOffset,
  pingOutcome,
  wasCacheCold,
} from './keepalive'
import type { DecideInput, Usage } from './keepalive'

const MIN = 60_000
const HOUR = 60 * MIN

// Cache written at t=0 with a 1h lifetime; "now" is 57 min later (3 min left).
const base: DecideInput = {
  now: 57 * MIN,
  inWorkHours: true,
  lastRequestAt: 0,
  ttlMs: HOUR,
  busy: false,
  lastHumanAt: null,
  compactedAt: null,
  paused: false,
  keepAlives: 0,
  maxIdlePings: 3,
  compactCold: false,
  contextTokens: 250_000,
  minCompactTokens: 50_000,
}

describe('decide', () => {
  test('pings in work hours when the cache has 5 min or less left', async () => {
    expect(decide(base)).toBe('ping')
    expect(decide({ ...base, now: 55 * MIN })).toBe('ping') // exactly 5 min left
    expect(decide({ ...base, now: 60 * MIN - 1 })).toBe('ping')
  })

  test('does nothing while a turn runs, with more than 5 min left, or once cold', async () => {
    expect(decide({ ...base, busy: true })).toBe('none')
    expect(decide({ ...base, now: 55 * MIN - 1 })).toBe('none')
    expect(decide({ ...base, now: 60 * MIN })).toBe('none') // exactly expired
    expect(decide({ ...base, now: 61 * MIN })).toBe('none')
    expect(decide({ ...base, lastRequestAt: null })).toBe('none')
  })

  test('a short lifetime acts at half of it, not on every tick', async () => {
    const short = { ...base, ttlMs: 4 * MIN }
    expect(decide({ ...short, now: 0 })).toBe('none') // right after a ping
    expect(decide({ ...short, now: 1 * MIN })).toBe('none')
    expect(decide({ ...short, now: 2 * MIN })).toBe('ping')
    expect(leadMs(HOUR)).toBe(5 * MIN)
    expect(leadMs(7 * MIN)).toBe(3.5 * MIN)
  })

  test('compacts outside work hours, once per round of human activity', async () => {
    const evening = { ...base, inWorkHours: false }
    expect(decide(evening)).toBe('compact')
    // compacted earlier, nobody typed since
    expect(decide({ ...evening, compactedAt: -30 * MIN, lastHumanAt: -40 * MIN })).toBe('none')
    expect(decide({ ...evening, compactedAt: -30 * MIN, lastHumanAt: null })).toBe('none')
    // compacted earlier, then the user worked again
    expect(decide({ ...evening, compactedAt: -30 * MIN, lastHumanAt: -10 * MIN })).toBe('compact')
  })

  test('idle cap: pings up to the limit, then compacts while the cache is warm', async () => {
    expect(decide({ ...base, keepAlives: 2 })).toBe('ping')
    expect(decide({ ...base, keepAlives: 3 })).toBe('compact')
    expect(decide({ ...base, keepAlives: 3, compactedAt: -30 * MIN, lastHumanAt: -40 * MIN })).toBe('none')
    expect(decide({ ...base, keepAlives: 10, maxIdlePings: 0 })).toBe('ping') // no limit
  })

  test('no compaction for a small context or after a cold one', async () => {
    const evening = { ...base, inWorkHours: false }
    expect(decide({ ...evening, contextTokens: 20_000 })).toBe('none')
    expect(decide({ ...evening, contextTokens: undefined })).toBe('compact')
    expect(decide({ ...evening, compactCold: true })).toBe('none')
    // pings don't depend on the context size
    expect(decide({ ...base, contextTokens: 20_000 })).toBe('ping')
  })

  test('paused: no pings and no compactions', async () => {
    expect(decide({ ...base, paused: true })).toBe('none')
    expect(decide({ ...base, inWorkHours: false, paused: true })).toBe('none')
  })

  test('next morning: the first message warms the cache again and pings resume', async () => {
    const morning = { ...base, compactedAt: -10 * HOUR, lastHumanAt: 0 }
    expect(decide(morning)).toBe('ping')
  })
})

const usage = (read: number, written: number, uncached = 12): Usage => ({
  input_tokens: uncached,
  output_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

describe('wasCacheCold', () => {
  test('warm reads the history; cold writes it again or sends it uncached', async () => {
    expect(wasCacheCold(usage(300_000, 40))).toBe(false)
    expect(wasCacheCold(usage(20_000, 280_000))).toBe(true)
    expect(wasCacheCold(usage(0, 0, 300_000))).toBe(true) // prompt caching off
  })
})

describe('pingOutcome', () => {
  test('judged by what was billed', async () => {
    expect(pingOutcome({ isAnswered: true, usage: usage(300_000, 0) })).toBe('warm')
    expect(pingOutcome({ isAnswered: true, usage: usage(20_000, 280_000) })).toBe('cold')
    // an empty reply still refreshed the cache
    expect(pingOutcome({ isAnswered: false, reason: 'empty-reply', usage: usage(300_000, 0) })).toBe('warm')
    // an API error that billed nothing did not
    expect(pingOutcome({ isAnswered: false, reason: 'api-error', usage: usage(0, 0, 0) })).toBe('failed')
    expect(pingOutcome({ isAnswered: false, reason: 'Error: refused' })).toBe('failed')
    expect(pingOutcome({ isAnswered: false, reason: 'nothing-to-fork' })).toBe('nothing-to-fork')
  })
})

describe('time helpers', () => {
  test('parseHHMM', async () => {
    expect(parseHHMM('20:00')).toBe(1200)
    expect(parseHHMM('7:05')).toBe(425)
    expect(parseHHMM('24:00')).toBeUndefined()
    expect(parseHHMM('8pm')).toBeUndefined()
  })

  test('parseUtcOffset', async () => {
    expect(parseUtcOffset('+07:00')).toBe(420)
    expect(parseUtcOffset('-05:30')).toBe(-330)
    expect(parseUtcOffset('+0530')).toBe(330)
    expect(parseUtcOffset('+14:00')).toBe(840)
    expect(parseUtcOffset('-12:00')).toBe(-720)
    expect(parseUtcOffset('+14:30')).toBeUndefined()
    expect(parseUtcOffset('-12:30')).toBeUndefined()
    expect(parseUtcOffset('+99:99')).toBeUndefined()
    expect(parseUtcOffset('')).toBeUndefined()
  })

  test('parseDays', async () => {
    expect(parseDays('Mon-Fri')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('mon,wed, FRI')).toEqual([1, 3, 5])
    expect(parseDays('Fri-Mon')).toEqual([0, 1, 5, 6])
    expect(parseDays('Monday-Friday')).toEqual([1, 2, 3, 4, 5])
    expect(parseDays('Mon-Sun')).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parseDays('Sun')).toEqual([0])
    expect(parseDays('')).toBeUndefined()
    expect(parseDays('Mo-Fr')).toBeUndefined()
    expect(parseDays('Mon--Fri')).toBeUndefined()
  })

  test('localMinutes and localDay with an explicit offset, across midnight', async () => {
    const utc1730 = Date.UTC(2026, 9, 10, 17, 30) // Saturday
    expect(localMinutes(utc1730, 420)).toBe(30) // 00:30 Sunday at +07:00
    expect(localDay(utc1730, 420)).toBe(0)
    expect(localMinutes(utc1730, -330)).toBe(12 * 60) // 12:00 Saturday at -05:30
    expect(localDay(utc1730, -330)).toBe(6)
  })

  test('inWindow, including a window that wraps midnight and an empty one', async () => {
    expect(inWindow(19 * 60 + 59, 7 * 60, 20 * 60)).toBe(true)
    expect(inWindow(20 * 60, 7 * 60, 20 * 60)).toBe(false)
    expect(inWindow(60, 7 * 60, 20 * 60)).toBe(false)
    expect(inWindow(60, 22 * 60, 2 * 60)).toBe(true)
    expect(inWindow(10 * 60, 10 * 60, 10 * 60)).toBe(false) // from == until
  })

  test('inWorkTime: work days, the end of the window, and a night shift at a negative offset', async () => {
    const days = [1, 2, 3, 4, 5]
    const day = { fromMinutes: 7 * 60, untilMinutes: 20 * 60, days, utcOffsetMinutes: 420 }
    expect(inWorkTime(Date.UTC(2026, 9, 12, 5, 0), day)).toBe(true) // Monday 12:00
    expect(inWorkTime(Date.UTC(2026, 9, 12, 13, 0), day)).toBe(false) // Monday 20:00
    expect(inWorkTime(Date.UTC(2026, 9, 10, 5, 0), day)).toBe(false) // Saturday 12:00

    // 22:00-06:00 at -05:00: the hours after midnight belong to the day the shift started
    const night = { fromMinutes: 22 * 60, untilMinutes: 6 * 60, days, utcOffsetMinutes: -300 }
    expect(inWorkTime(Date.UTC(2026, 9, 17, 4, 0), night)).toBe(true) // Friday 23:00
    expect(inWorkTime(Date.UTC(2026, 9, 17, 7, 0), night)).toBe(true) // Saturday 02:00, Friday's shift
    expect(inWorkTime(Date.UTC(2026, 9, 18, 4, 0), night)).toBe(false) // Saturday 23:00
    expect(inWorkTime(Date.UTC(2026, 9, 12, 7, 0), night)).toBe(false) // Monday 02:00, Sunday's shift
    expect(inWorkTime(Date.UTC(2026, 9, 13, 4, 0), night)).toBe(true) // Monday 23:00
  })
})
