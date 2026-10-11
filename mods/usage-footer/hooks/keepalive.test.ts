import { describe, expect, test } from 'claude-code/testing'

import { decide, inWindow, localMinutes, parseHHMM, parseUtcOffset, wasCacheCold } from './keepalive'
import type { DecideInput } from './keepalive'

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
}

describe('decide', () => {
  test('pings in work hours when the cache has 5 min or less left', async () => {
    expect(decide(base)).toBe('ping')
    expect(decide({ ...base, now: 55 * MIN })).toBe('ping')
  })

  test('does nothing while a turn runs, with more than 5 min left, or once cold', async () => {
    expect(decide({ ...base, busy: true })).toBe('none')
    expect(decide({ ...base, now: 54 * MIN })).toBe('none')
    expect(decide({ ...base, now: 61 * MIN })).toBe('none')
    expect(decide({ ...base, lastRequestAt: null })).toBe('none')
  })

  test('compacts outside work hours, once per round of human activity', async () => {
    const evening = { ...base, inWorkHours: false }
    expect(decide(evening)).toBe('compact')
    // compacted earlier, nobody typed since
    expect(decide({ ...evening, compactedAt: -30 * MIN, lastHumanAt: -40 * MIN })).toBe('none')
    // compacted earlier, then the user worked again
    expect(decide({ ...evening, compactedAt: -30 * MIN, lastHumanAt: -10 * MIN })).toBe('compact')
  })

  test('paused after a cold ping: no pings and no compactions', async () => {
    expect(decide({ ...base, paused: true })).toBe('none')
    expect(decide({ ...base, inWorkHours: false, paused: true })).toBe('none')
  })

  test('next morning: the first message warms the cache again and pings resume', async () => {
    const morning = { ...base, compactedAt: -10 * HOUR, lastHumanAt: 0 }
    expect(decide(morning)).toBe('ping')
  })
})

describe('wasCacheCold', () => {
  test('warm ping reads the history; cold ping writes it again', async () => {
    expect(wasCacheCold({ cache_read_input_tokens: 300_000, cache_creation_input_tokens: 40 })).toBe(false)
    expect(wasCacheCold({ cache_read_input_tokens: 20_000, cache_creation_input_tokens: 280_000 })).toBe(true)
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
    expect(parseUtcOffset('')).toBeUndefined()
  })

  test('localMinutes with an explicit offset, across midnight', async () => {
    const utc1730 = Date.UTC(2026, 9, 10, 17, 30)
    expect(localMinutes(utc1730, 420)).toBe(30) // 00:30 next day at +07:00
    expect(localMinutes(utc1730, -330)).toBe(12 * 60) // 12:00 at -05:30
  })

  test('inWindow, including a window that wraps midnight', async () => {
    expect(inWindow(19 * 60 + 59, 7 * 60, 20 * 60)).toBe(true)
    expect(inWindow(20 * 60, 7 * 60, 20 * 60)).toBe(false)
    expect(inWindow(60, 7 * 60, 20 * 60)).toBe(false)
    expect(inWindow(60, 22 * 60, 2 * 60)).toBe(true)
  })
})
