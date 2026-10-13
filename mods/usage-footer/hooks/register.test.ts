import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement, SessionUsage } from 'claude-code'

import { bar, buildSegments, configuredEffort, costNote, modelName, tokens } from './register'
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

describe('log line figures', () => {
  test('tokens: k above 1000, one decimal below 10k', async () => {
    expect(tokens(312_456)).toBe('312k')
    expect(tokens(2_345)).toBe('2.3k')
    expect(tokens(40)).toBe('40')
  })

  test('costNote: tokens and the 5-hour meter, each when known', async () => {
    const u = { input_tokens: 3, output_tokens: 320, cache_read_input_tokens: 312_000, cache_creation_input_tokens: 2_000 }
    expect(costNote(u, 23.4, 23.6)).toBe('cache read 312k, written 2.0k, uncached 3, out 320; 5h 23.4% → 23.6%')
    expect(costNote(u, undefined, undefined)).toBe('cache read 312k, written 2.0k, uncached 3, out 320')
    expect(costNote(undefined, undefined, 7)).toBe('5h ? → 7.0%')
    expect(costNote(undefined, undefined, undefined)).toBe('')
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

// At +07:00: Monday 2026-10-12 12:00 local = 05:00 UTC, 20:30 local = 13:30 UTC; Saturday 2026-10-10 12:00.
const NOON_LOCAL = Date.UTC(2026, 9, 12, 5, 0)
const EVENING_LOCAL = Date.UTC(2026, 9, 12, 13, 30)
const SATURDAY_NOON = Date.UTC(2026, 9, 10, 5, 0)
const MIN = 60_000
const options = { utcOffset: '+07:00' }

const tokenUsage = (read: number, written: number, uncached = 1) => ({
  input_tokens: uncached,
  output_tokens: 1,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})
const OK_REPLY = { isAnswered: true, text: 'ok', usage: tokenUsage(300_000, 0) } as const
const FAILED_REPLY = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: tokenUsage(0, 0, 0) } as const
const COMPACTED = { messages: [{ role: 'user', text: 'summary of the session', toolUses: [] }], usage: tokenUsage(300_000, 0) }

type World = {
  forks: number
  compactions: number
  logs: string[]
  // What $.session.usage() reports: the 5-hour meter and the context size.
  fiveHour: number
  contextTokens: number
}

type Stand = {
  fork?: (n: number) => unknown
  compact?: () => unknown
  contextTokens?: number
}

// Stand in for the engine beneath the plugin, start the session (arms the 30 s tick)
// and send one main-thread model request at the clock's current time.
async function startWithOneRequest($: Engine, on: On, stand: Stand = {}): Promise<World> {
  const world: World = { forks: 0, compactions: 0, logs: [], fiveHour: 23.4, contextTokens: stand.contextTokens ?? 250_000 }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: world.contextTokens, window: 1_000_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: world.fiveHour }],
    },
  }))
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('model.fork', async () => {
    world.forks += 1
    return { value: await (stand.fork ?? (() => OK_REPLY))(world.forks) } as never
  })
  on('session.compact', () => {
    world.compactions += 1
    return (stand.compact ?? (() => COMPACTED))() as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($, 't1')
  return world
}

// One main-thread model request, as a turn sends it.
async function step($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // no chunks
  }
}

const userIsBack = async ($: Engine, turnId: string) => {
  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await step($, turnId)
}

const pings = (world: World) => world.logs.filter(l => /keep-alive ping at \d\d:\d\d: /.test(l))

describe('keep-alive tick', () => {
  test('a failed ping restores the countdown and is retried on the next tick', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on, { fork: n => (n === 1 ? FAILED_REPLY : OK_REPLY) })

    await clock.advance(56 * MIN)
    expect(world.forks).toBe(2)
    expect(world.logs.some(l => l.includes('failed (api-error)'))).toBe(true)
    expect(pings(world).length).toBe(1)
  })

  test('pings that keep failing pause keep-alive until the user types again', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on, { fork: () => FAILED_REPLY })

    await clock.advance(58 * MIN)
    expect(world.forks).toBe(3)
    expect(world.logs.some(l => l.includes('3 in a row; keep-alive is paused'))).toBe(true)

    // the user is back: the countdown and the failure count start over
    await userIsBack($, 't2')
    await clock.advance(54 * MIN)
    expect(world.forks).toBe(3)
    await clock.advance(1 * MIN)
    expect(world.forks).toBe(4)
    await clock.advance(5 * MIN)
    expect(world.forks).toBe(6)
  })

  test('a ping failing while a turn starts keeps the newer request time', { options }, async ($, on) => {
    const clock: MockClock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on, {
      fork: async () => {
        await clock.sleep(10_000)
        return FAILED_REPLY
      },
    })

    await clock.advance(55 * MIN) // the ping starts and waits for its reply
    expect(world.forks).toBe(1)
    await clock.advance(5_000)
    await step($, 't2') // the user's turn sends a request meanwhile
    await clock.advance(5 * MIN) // the ping fails; the turn's request time stays
    expect(world.forks).toBe(1)
  })

  test('a ping that finds the cache cold pauses keep-alive until the user types again', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const cold = { isAnswered: true, text: 'ok', usage: tokenUsage(20_000, 280_000, 10) }
    const world = await startWithOneRequest($, on, { fork: n => (n === 1 ? cold : OK_REPLY) })

    await clock.advance(56 * MIN)
    expect(world.forks).toBe(1)
    expect(world.logs.some(l => l.includes('found the cache already cold'))).toBe(true)
    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(1)
    expect(world.compactions).toBe(0)

    // the user is back: a message and its model request re-arm the keep-alive
    await userIsBack($, 't2')
    await clock.advance(56 * MIN)
    expect(world.forks).toBe(2)
  })

  test('in work hours an idle session gets one ping per hour', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on)

    await clock.advance(54 * MIN)
    expect(world.forks).toBe(0)
    await clock.advance(2 * MIN) // 56 min: within 5 min of expiry
    expect(world.forks).toBe(1)
    await clock.advance(50 * MIN) // the ping restarted the hour
    expect(world.forks).toBe(1)
    await clock.advance(6 * MIN)
    expect(world.forks).toBe(2)
    expect(world.compactions).toBe(0)
    expect(pings(world).length).toBe(2)
  })

  test('each ping logs its tokens and the 5-hour meter', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on, {
      fork: () => {
        world.fiveHour = 23.5
        return OK_REPLY
      },
    })

    await clock.advance(56 * MIN)
    expect(pings(world)).toEqual(['usage-footer: keep-alive ping at 12:55: cache read 300k, written 0, uncached 1, out 1; 5h 23.4% → 23.5%'])
  })

  test('in work hours an idle session is compacted after the ping limit', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on)

    await clock.advance(56 * MIN)
    await clock.advance(55 * MIN)
    await clock.advance(55 * MIN)
    expect(world.forks).toBe(3)
    expect(world.compactions).toBe(0)
    await clock.advance(55 * MIN) // the fourth near-expiry compacts instead
    expect(world.forks).toBe(3)
    expect(world.compactions).toBe(1)
    expect(world.logs.some(l => l.includes('compacted at 15:40, idle after 3 pings'))).toBe(true)
    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(3)
    expect(world.compactions).toBe(1)
  })

  test('after work hours an idle session is compacted once, then left alone', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: EVENING_LOCAL })
    const world = await startWithOneRequest($, on)

    await clock.advance(56 * MIN)
    expect(world.compactions).toBe(1)
    expect(world.forks).toBe(0)
    await clock.advance(3 * 60 * MIN)
    expect(world.compactions).toBe(1)
    expect(world.logs.some(l => l.includes('compacted at 21:25, idle outside work hours (cache read 300k'))).toBe(true)
  })

  test('on a day off an idle session is compacted, not kept warm', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: SATURDAY_NOON })
    const world = await startWithOneRequest($, on)

    await clock.advance(56 * MIN)
    expect(world.forks).toBe(0)
    expect(world.compactions).toBe(1)
  })

  test('a small context is left to expire instead of compacted', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: EVENING_LOCAL })
    const world = await startWithOneRequest($, on, { contextTokens: 20_000 })

    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(0)
    expect(world.compactions).toBe(0)
  })

  test('a compaction that finds the cache cold stops automatic compactions in the session', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: EVENING_LOCAL })
    const world = await startWithOneRequest($, on, { compact: () => ({ ...COMPACTED, usage: tokenUsage(20_000, 280_000) }) })

    await clock.advance(56 * MIN)
    expect(world.compactions).toBe(1)
    expect(world.logs.some(l => l.includes('but the cache was cold'))).toBe(true)

    await userIsBack($, 't2')
    await clock.advance(3 * 60 * MIN)
    expect(world.compactions).toBe(1)
  })

  test('after /clear there is nothing to keep warm', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on, { fork: () => ({ isAnswered: false, reason: 'nothing-to-fork' }) })

    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(1)
    expect(world.logs.some(l => l.includes('nothing to keep warm'))).toBe(true)
  })

  test('a /compact of your own clears the countdown: no pings for the old conversation', { options }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on)

    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(0)
    expect(world.compactions).toBe(1)
  })

  test('switched off: no pings', { options: { ...options, keepAlive: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on)

    await clock.advance(3 * 60 * MIN)
    expect(world.forks).toBe(0)
    expect(world.compactions).toBe(0)
  })
})

describe('logUsage', () => {
  test('one line per main-thread turn with its tokens and the 5-hour meter', { options: { ...options, logUsage: true } }, async ($, on) => {
    mock.clock(on, { now: NOON_LOCAL })
    const world = await startWithOneRequest($, on)

    world.fiveHour = 10
    await $.turn.start({ text: 'ok', turnId: 't2' })
    world.fiveHour = 10.4
    const turnUsage = { ...tokenUsage(312_000, 2_000, 3), output_tokens: 320, model: 'claude-opus-5-5' }
    await $.turn.complete({ answer: 'ok', durationMs: 900, isAborted: false, turnId: 't2', reason: 'answer', usage: turnUsage })

    expect(world.logs).toContain('usage-footer: turn: cache read 312k, written 2.0k, uncached 3, out 320; 5h 10.0% → 10.4%')
  })
})
