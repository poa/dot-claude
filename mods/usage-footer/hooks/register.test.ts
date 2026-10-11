import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionUsage } from 'claude-code'

import { bar, buildSegments, configuredEffort, modelName } from './register'
import type { Segment } from './register'

const usage: SessionUsage = {
  startedAt: 0,
  context: { tokens: 250_000, window: 1_000_000, percent: 25 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 85.4 },
    { kind: 'seven_day', percentUsed: 6 },
  ],
  cost: { usd: 1 },
}

const text = (s: Segment) => s.map(p => p.text).join('')
const fillColor = (s: Segment) => s[0]?.color

describe('modelName', () => {
  test('turns model IDs into display names', async () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(modelName('Opus 5.5')).toBe('Opus 5.5')
  })
})

describe('configuredEffort', () => {
  test('per-model effort wins over the top-level one', async () => {
    const settings = { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }
    expect(configuredEffort(settings, 'claude-opus-5-5')).toBe('xhigh')
    expect(configuredEffort(settings, 'claude-sonnet-5-5')).toBe('medium')
    expect(configuredEffort({}, 'claude-opus-5-5')).toBeUndefined()
  })
})

describe('bar', () => {
  test('10 cells, filled part rounded, bar only', async () => {
    expect(text(bar(25))).toBe('▰▰▰▱▱▱▱▱▱▱')
    expect(text(bar(0))).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(text(bar(100))).toBe('▰▰▰▰▰▰▰▰▰▰')
  })

  test('green under 50%, yellow under 80%, red from 80%', async () => {
    expect(fillColor(bar(49))).toBe('green')
    expect(fillColor(bar(50))).toBe('yellow')
    expect(fillColor(bar(79))).toBe('yellow')
    expect(fillColor(bar(80))).toBe('red')
  })
})

describe('buildSegments', () => {
  test('model, effort, context bar and 5h limit; no cache before the first request', async () => {
    const s = buildSegments(usage, 'Opus 5.5', 'medium', undefined, 0)
    expect(s.map(text)).toEqual(['Opus 5.5', 'medium', '▰▰▰▱▱▱▱▱▱▱', '5h 85%'])
    expect(s[3]?.[0]?.color).toBe('red')
  })

  test('cache countdown: green above 15m, yellow at 15m or less, red when cold', async () => {
    const last = 1_000_000
    expect(buildSegments(usage, undefined, undefined, last, last + 18 * 60_000 + 1).at(-1)).toEqual([{ text: 'cache 42m', color: 'green' }])
    expect(buildSegments(usage, undefined, undefined, last, last + 50 * 60_000).at(-1)).toEqual([{ text: 'cache 10m', color: 'yellow' }])
    expect(buildSegments(usage, undefined, undefined, 0, 61 * 60_000).at(-1)).toEqual([{ text: 'cache cold', color: 'red' }])
  })

  test('nothing to show before any response and without a model', async () => {
    expect(buildSegments({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }, undefined, undefined, undefined, 0)).toEqual([])
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws colored segments after the engine's modes on ${surface}`, async ($, on) => {
    mock.clock(on)
    on('session.usage', () => ({ value: usage }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('ui.render', { component: 'SessionMode' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, e.props.modes.join(' & ')) as RenderElement
    })

    const ui = await $.ui.mount({ plugin: 'usage-footer', surface, component: 'SessionMode', props: { modes: ['focus'] } })

    expect(await ui.find({ text: 'focus' })).toBeDefined()
    expect(await ui.find({ text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ text: '▰▰▰' })).toBeDefined()
    expect(await ui.find({ text: '▱▱▱▱▱▱▱' })).toBeDefined()
    expect(await ui.find({ text: '5h 85%' })).toBeDefined()
  })
}

// 2026-10-10 at +07:00: 12:00 local = 05:00 UTC, 20:30 local = 13:30 UTC.
const NOON_LOCAL = Date.UTC(2026, 9, 10, 5, 0)
const EVENING_LOCAL = Date.UTC(2026, 9, 10, 13, 30)
const MIN = 60_000
const options = { utcOffset: '+07:00' }

type Counts = { forks: number; compactions: number; logs: string[] }

// Stand in for the engine beneath the plugin, start the session (arms the 30 s tick)
// and send one main-thread model request at the clock's current time.
const OK_REPLY = { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } as const

async function startWithOneRequest(
  $: Engine,
  on: On,
  forkReply: (n: number) => unknown = () => OK_REPLY,
): Promise<Counts> {
  const counts: Counts = { forks: 0, compactions: 0, logs: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.log', (_, e) => {
    counts.logs.push(e.text)
    return { value: undefined }
  })
  on('model.fork', () => {
    counts.forks += 1
    return { value: forkReply(counts.forks) } as never
  })
  on('session.compact', () => {
    counts.compactions += 1
    return { messages: [{ role: 'user', text: 'summary of the session', toolUses: [] }] } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // no chunks
  }
  return counts
}

describe('keep-alive tick', () => {
  test('a failed ping restores the countdown and is retried on the next tick', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const failed = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    const counts = await startWithOneRequest($, on, n => (n === 1 ? failed : OK_REPLY))

    await clock.advance(56 * MIN)
    expect(counts.forks).toBe(2)
    expect(counts.logs.some(l => l.includes('failed (api-error)'))).toBe(true)
    expect(counts.logs.filter(l => /keep-alive ping at \d\d:\d\d$/.test(l)).length).toBe(1)
  })

  test('a ping that finds the cache cold pauses keep-alive until the user types again', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const cold = { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 280_000 } }
    const counts = await startWithOneRequest($, on, n => (n === 1 ? cold : OK_REPLY))

    await clock.advance(56 * MIN)
    expect(counts.forks).toBe(1)
    expect(counts.logs.some(l => l.includes('found the cache already cold'))).toBe(true)
    await clock.advance(3 * 60 * MIN)
    expect(counts.forks).toBe(1)
    expect(counts.compactions).toBe(0)

    // the user is back: a message and its model request re-arm the keep-alive
    await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 })) {
      // no chunks
    }
    await clock.advance(56 * MIN)
    expect(counts.forks).toBe(2)
  })

  test('in work hours an idle session gets one ping per hour', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const counts = await startWithOneRequest($, on)

    await clock.advance(54 * MIN)
    expect(counts.forks).toBe(0)
    await clock.advance(2 * MIN) // 56 min: within 5 min of expiry
    expect(counts.forks).toBe(1)
    await clock.advance(50 * MIN) // the ping restarted the hour
    expect(counts.forks).toBe(1)
    await clock.advance(6 * MIN)
    expect(counts.forks).toBe(2)
    expect(counts.compactions).toBe(0)
    expect(counts.logs.filter(l => l.includes('keep-alive ping')).length).toBe(2)
  })

  test('after work hours an idle session is compacted once, then left alone', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: EVENING_LOCAL })
    const counts = await startWithOneRequest($, on)

    await clock.advance(56 * MIN)
    expect(counts.compactions).toBe(1)
    expect(counts.forks).toBe(0)
    await clock.advance(3 * 60 * MIN)
    expect(counts.compactions).toBe(1)
    expect(counts.logs.some(l => l.includes('compacted at'))).toBe(true)
  })

  test('switched off: no pings', { options: { ...options, keepAlive: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const counts = await startWithOneRequest($, on)

    await clock.advance(3 * 60 * MIN)
    expect(counts.forks).toBe(0)
    expect(counts.compactions).toBe(0)
  })
})
