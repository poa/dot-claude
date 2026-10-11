import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, SessionUsage } from 'claude-code'

import { decide, inWindow, localMinutes, MINUTE_MS, parseHHMM, parseUtcOffset, wasCacheCold } from './keepalive'

const REDRAW_EVERY_MS = 30 * 1000
const PING_PROMPT = 'Keep-alive ping to keep the prompt cache warm. Reply with the single word: ok'

// Session state, kept across hot reloads (module variables are not).
const lastRequestAtAtom = atom({ plugin: 'usage-footer', key: 'lastRequestAt' } as const, null)
const effortAtom = atom({ plugin: 'usage-footer', key: 'effort' } as const, null)
const busyAtom = atom({ plugin: 'usage-footer', key: 'busy' } as const, false)
const lastHumanAtAtom = atom({ plugin: 'usage-footer', key: 'lastHumanAt' } as const, null)
const compactedAtAtom = atom({ plugin: 'usage-footer', key: 'compactedAt' } as const, null)
const keepAlivesAtom = atom({ plugin: 'usage-footer', key: 'keepAlives' } as const, 0)
const pausedAtom = atom({ plugin: 'usage-footer', key: 'paused' } as const, false)

export type Settings = {
  keepAlive: boolean
  fromMinutes: number
  untilMinutes: number
  untilText: string
  utcOffsetMinutes: number | undefined
  ttlMs: number
}

export function readSettings(options: PluginOptions): Settings {
  const from = parseHHMM(String(options.keepAliveFrom ?? '07:00')) ?? 7 * 60
  const until = parseHHMM(String(options.keepAliveUntil ?? '20:00')) ?? 20 * 60
  const ttl = typeof options.cacheTtlMinutes === 'number' && options.cacheTtlMinutes > 0 ? options.cacheTtlMinutes : 60
  return {
    keepAlive: options.keepAlive !== false,
    fromMinutes: from,
    untilMinutes: until,
    untilText: hhmm(until),
    utcOffsetMinutes: parseUtcOffset(String(options.utcOffset ?? '')),
    ttlMs: ttl * MINUTE_MS,
  }
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

// Per-model setting (modelSettings.<model>.effortLevel) wins over the top-level effortLevel.
export function configuredEffort(settings: Readonly<Record<string, unknown>>, model: string): string | undefined {
  const perModel = settings.modelSettings
  if (typeof perModel === 'object' && perModel !== null) {
    const entry = (perModel as Record<string, unknown>)[model]
    if (typeof entry === 'object' && entry !== null) {
      const level = (entry as Record<string, unknown>).effortLevel
      if (typeof level === 'string') {
        return level
      }
    }
  }
  return typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined
}

// claude-opus-5-5 -> Opus 5.5, claude-haiku-4-5-20251001 -> Haiku 4.5; anything else as is.
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id)
  if (!m || !m[1] || !m[2]) {
    return id
  }
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export type Part = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Segment = Part[]

const BAR_CELLS = 10

const byPercent = (percent: number) => (percent >= 80 ? 'red' : percent >= 50 ? 'yellow' : 'green')

export function bar(percent: number): Segment {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
  const color = byPercent(percent)
  return [
    { text: '▰'.repeat(filled), color },
    { text: '▱'.repeat(BAR_CELLS - filled), dim: true },
  ]
}

export function buildSegments(
  usage: SessionUsage,
  model: string | undefined,
  effort: string | undefined,
  lastRequestAt: number | undefined,
  now: number,
  ttlMs = 60 * MINUTE_MS,
): Segment[] {
  const segments: Segment[] = []

  if (model) {
    segments.push([{ text: model, color: 'magenta', bold: true }])
  }
  if (effort) {
    segments.push([{ text: effort, color: 'cyan' }])
  }

  if (usage.context.percent !== undefined) {
    segments.push(bar(usage.context.percent))
  }

  const fiveHour = usage.rateLimits.find(r => r.kind === 'five_hour')
  if (fiveHour) {
    segments.push([{ text: `5h ${Math.round(fiveHour.percentUsed)}%`, color: byPercent(fiveHour.percentUsed) }])
  }

  if (lastRequestAt !== undefined) {
    const leftMin = Math.ceil((lastRequestAt + ttlMs - now) / MINUTE_MS)
    segments.push([
      leftMin > 0
        ? { text: `cache ${leftMin}m`, color: leftMin > 15 ? 'green' : 'yellow' }
        : { text: 'cache cold', color: 'red' },
    ])
  }

  return segments
}

// Dim footer note on what the keep-alive will do next.
export function keepAliveSegment(
  settings: Settings,
  inWorkHours: boolean,
  keepAlives: number,
  lastHumanAt: number | null,
  compactedAt: number | null,
  paused = false,
): Segment | undefined {
  if (!settings.keepAlive) {
    return undefined
  }
  if (paused) {
    return [{ text: 'keep-alive paused: cache was cold', color: 'yellow' }]
  }
  if (inWorkHours) {
    const count = keepAlives > 0 ? ` ×${keepAlives}` : ''
    return [{ text: `keep-alive${count} →${settings.untilText}`, dim: true }]
  }
  const humanSinceCompaction = compactedAt === null || (lastHumanAt !== null && lastHumanAt > compactedAt)
  return humanSinceCompaction ? [{ text: 'compact on expiry', dim: true }] : undefined
}

// Module scope on purpose: a reload drops it with the old module, and one action at a time is enough.
let acting = false

const isWorkHours = (settings: Settings, now: number) =>
  inWindow(localMinutes(now, settings.utcOffsetMinutes), settings.fromMinutes, settings.untilMinutes)

// One tick of the keep-alive: ping, compact, or nothing (see decide()).
async function act($: EngineInterface, settings: Settings) {
  if (!settings.keepAlive || acting) {
    return
  }
  const now = await $.clock.now()
  const decision = decide({
    now,
    inWorkHours: isWorkHours(settings, now),
    lastRequestAt: await read($, lastRequestAtAtom),
    ttlMs: settings.ttlMs,
    busy: await read($, busyAtom),
    lastHumanAt: await read($, lastHumanAtAtom),
    compactedAt: await read($, compactedAtAtom),
    paused: await read($, pausedAtom),
  })
  if (decision === 'none') {
    return
  }

  acting = true
  const at = hhmm(localMinutes(now, settings.utcOffsetMinutes))
  try {
    if (decision === 'ping') {
      // The cache lifetime counts from the request start; restored if the ping fails,
      // so the next tick retries while the cache is still warm.
      const previous = await read($, lastRequestAtAtom)
      await update($, lastRequestAtAtom, () => now)
      let failure: string | undefined
      let cold = false
      try {
        const reply = await $.model.fork({ prompt: PING_PROMPT })
        failure = reply.isAnswered ? undefined : reply.reason
        cold = reply.isAnswered && wasCacheCold(reply.usage)
      } catch (error) {
        failure = String(error)
      }
      if (cold) {
        // The ping rebuilt the cache instead of refreshing it: the real lifetime is shorter
        // than cacheTtlMinutes (e.g. 5m during usage overage). Further pings would each cost
        // a full rebuild, so stop until the user is back.
        await update($, pausedAtom, () => true)
        $.ui.log(
          `usage-footer: keep-alive ping at ${at} found the cache already cold; the cache lifetime looks shorter than ` +
            `${Math.round(settings.ttlMs / MINUTE_MS)} min, so keep-alive is paused until your next message`,
        )
      } else if (failure === undefined) {
        await update($, keepAlivesAtom, n => n + 1)
        $.ui.log(`usage-footer: keep-alive ping at ${at}`)
      } else {
        await update($, lastRequestAtAtom, () => previous)
        $.ui.log(`usage-footer: keep-alive ping at ${at} failed (${failure})`)
      }
    } else {
      // Skipped or failed compactions are not retried until the user types again.
      let note: string
      try {
        const result = await $.session.compact()
        note = result.messages === undefined ? `skipped (${result.skip})` : 'done'
      } catch (error) {
        note = `failed (${String(error)})`
      }
      const done = await $.clock.now()
      await update($, compactedAtAtom, () => done)
      if (note === 'done') {
        await update($, lastRequestAtAtom, () => null)
        await update($, keepAlivesAtom, () => 0)
        $.ui.log(`usage-footer: compacted at ${at}, idle outside work hours`)
      } else {
        $.ui.log(`usage-footer: compaction at ${at} ${note}`)
      }
    }
  } finally {
    acting = false
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    // Effort: what the last main-thread request sent; the configured level until the first one.
    if ((await read($, effortAtom)) === null) {
      const effortLevel = configuredEffort(await $.settings.read(), await $.session.model())
      if (effortLevel !== undefined) {
        await update($, effortAtom, () => effortLevel)
      }
    }
    $.clock.every(REDRAW_EVERY_MS, () => {
      $.ui.invalidate('ui.render')
      void act($, settings)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const now = await $.clock.now()
      await update($, lastHumanAtAtom, () => now)
      await update($, keepAlivesAtom, () => 0)
      await update($, pausedAtom, () => false)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, busyAtom, () => true)
    return next(e)
  })

  // The API measures the cache lifetime from the start of the request that last read
  // or wrote the entry, so record the time before the request is sent.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const startedAt = await $.clock.now()
      await update($, lastRequestAtAtom, () => startedAt)
      if (e.effort !== undefined) {
        const effort = String(e.effort)
        await update($, effortAtom, () => effort)
      }
      $.ui.invalidate('ui.render')
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, busyAtom, () => false)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const now = await $.clock.now()
    const segments = buildSegments(
      await $.session.usage(),
      modelName(await $.session.model()),
      (await read($, effortAtom)) ?? undefined,
      (await read($, lastRequestAtAtom)) ?? undefined,
      now,
      settings.ttlMs,
    )
    const keepAlive = keepAliveSegment(
      settings,
      isWorkHours(settings, now),
      await read($, keepAlivesAtom),
      await read($, lastHumanAtAtom),
      await read($, compactedAtAtom),
      await read($, pausedAtom),
    )
    if (keepAlive) {
      segments.push(keepAlive)
    }
    const inner = await next(e)
    if (segments.length === 0) {
      return inner
    }

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {inner}
        {segments.map((parts, i) => (
          <Text>
            {i === 0 ? ' ' : <Text dimColor> · </Text>}
            {parts.map(p => (
              <Text color={p.color} bold={p.bold} dimColor={p.dim}>{p.text}</Text>
            ))}
          </Text>
        ))}
      </Box>
    ) as RenderElement
  })
}
