import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, SessionCompactResult, SessionUsage } from 'claude-code'

import type { PauseReason } from '../types'
import {
  billedInput,
  decide,
  inWorkTime,
  localDate,
  localMinutes,
  MINUTE_MS,
  parseDays,
  parseHHMM,
  parseUtcOffset,
  pingOutcome,
  plan,
  wasCacheCold,
} from './keepalive'
import type { ForkReply, PlanInput, Usage, WorkTime } from './keepalive'

const REDRAW_EVERY_MS = 30 * 1000
const PING_PROMPT = 'Keep-alive ping to keep the prompt cache warm. Reply with the single word: ok'
// Failed pings in a row before keep-alive pauses until the user's next message.
const MAX_FAILED_PINGS = 3
const WEEKDAYS = [1, 2, 3, 4, 5]

// Session state, kept across hot reloads (module variables are not).
const lastRequestAtAtom = atom({ plugin: 'usage-footer', key: 'lastRequestAt' } as const, null)
const effortAtom = atom({ plugin: 'usage-footer', key: 'effort' } as const, null)
const modelAtom = atom({ plugin: 'usage-footer', key: 'model' } as const, null)
const busyAtom = atom({ plugin: 'usage-footer', key: 'busy' } as const, false)
const lastHumanAtAtom = atom({ plugin: 'usage-footer', key: 'lastHumanAt' } as const, null)
const compactedAtAtom = atom({ plugin: 'usage-footer', key: 'compactedAt' } as const, null)
const keepAlivesAtom = atom({ plugin: 'usage-footer', key: 'keepAlives' } as const, 0)
const pausedByAtom = atom({ plugin: 'usage-footer', key: 'pausedBy' } as const, null)
const failuresAtom = atom({ plugin: 'usage-footer', key: 'failures' } as const, 0)
const compactColdAtom = atom({ plugin: 'usage-footer', key: 'compactCold' } as const, false)

export type Settings = WorkTime & {
  keepAlive: boolean
  untilText: string
  ttlMs: number
  maxIdlePings: number
  minCompactTokens: number
  logUsage: boolean
  showFiveHour: boolean
  showWeek: boolean
}

// A number option clamped to [min, max]; the default when unset.
const numberOption = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function readSettings(options: PluginOptions): Settings {
  const from = parseHHMM(String(options.keepAliveFrom ?? '07:00')) ?? 7 * 60
  const until = parseHHMM(String(options.keepAliveUntil ?? '20:00')) ?? 20 * 60
  return {
    keepAlive: options.keepAlive !== false,
    fromMinutes: from,
    untilMinutes: until,
    untilText: hhmm(until),
    days: parseDays(String(options.keepAliveDays ?? 'Mon-Fri')) ?? WEEKDAYS,
    utcOffsetMinutes: parseUtcOffset(String(options.utcOffset ?? '')),
    ttlMs: numberOption(options.cacheTtlMinutes, 60, 2, 60) * MINUTE_MS,
    maxIdlePings: Math.round(numberOption(options.maxIdlePings, 3, 0, 24)),
    minCompactTokens: numberOption(options.minCompactTokens, 50_000, 0, 10_000_000),
    logUsage: options.logUsage === true,
    showFiveHour: options.showFiveHour !== false,
    showWeek: options.showWeek !== false,
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

// A plan window's use, with the one decimal the engine reports, and when it resets; undefined off a subscription.
export function meter(usage: SessionUsage, kind: 'five_hour' | 'seven_day') {
  const limit = usage.rateLimits.find(r => r.kind === kind)
  return { used: limit?.percentUsed, resetsAt: limit?.resetsAt }
}

export const fiveHourUsed = (usage: SessionUsage) => meter(usage, 'five_hour').used

// 312_456 -> 312k, 2_345 -> 2.3k, 40 -> 40
export function tokens(n: number): string {
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`
  }
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// What a request cost, for the log lines: its tokens and the 5-hour meter before and after.
export function costNote(u: Usage | undefined, before: number | undefined, after: number | undefined): string {
  const parts: string[] = []
  if (u !== undefined) {
    parts.push(
      `cache read ${tokens(u.cache_read_input_tokens)}, written ${tokens(u.cache_creation_input_tokens)}, ` +
        `uncached ${tokens(u.input_tokens)}, out ${tokens(u.output_tokens)}`,
    )
  }
  if (before !== undefined || after !== undefined) {
    const percent = (p: number | undefined) => (p === undefined ? '?' : `${p.toFixed(1)}%`)
    parts.push(`5h ${percent(before)} → ${percent(after)}`)
  }
  return parts.join('; ')
}

// One line of the usage log (logUsage), for bin/claude-keepalive-report.sh.
export type LogRecord = { kind: 'request' | 'ping' | 'compact'; t: number; [field: string]: string | number | boolean | undefined }

// What a request, ping or compaction cost and both meters after it; `t` is when it started.
export function logRecord(
  kind: LogRecord['kind'],
  t: number,
  u: Usage | undefined,
  after: SessionUsage,
  extra: Record<string, string | number | boolean | undefined> = {},
): LogRecord {
  const h5 = meter(after, 'five_hour')
  const d7 = meter(after, 'seven_day')
  return {
    kind,
    t,
    ...extra,
    read: u?.cache_read_input_tokens,
    write: u?.cache_creation_input_tokens,
    input: u?.input_tokens,
    output: u?.output_tokens,
    h5: h5.used,
    h5Reset: h5.resetsAt,
    d7: d7.used,
    d7Reset: d7.resetsAt,
  }
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
  show = { fiveHour: true, week: true },
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

  const fiveHour = fiveHourUsed(usage)
  if (show.fiveHour && fiveHour !== undefined) {
    segments.push([{ text: `5h ${Math.round(fiveHour)}%`, color: byPercent(fiveHour) }])
  }
  const week = meter(usage, 'seven_day').used
  if (show.week && week !== undefined) {
    segments.push([{ text: `7d ${Math.round(week)}%`, color: byPercent(week) }])
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
export function keepAliveSegment(settings: Settings, p: PlanInput, pausedBy: PauseReason | null): Segment | undefined {
  if (!settings.keepAlive) {
    return undefined
  }
  if (pausedBy !== null) {
    return [{ text: pausedBy === 'cold' ? 'keep-alive paused: cache was cold' : 'keep-alive paused: pings failed', color: 'yellow' }]
  }
  switch (plan(p)) {
    case 'ping': {
      const limit = p.maxIdlePings > 0 ? `/${p.maxIdlePings}` : ''
      const count = p.keepAlives > 0 ? ` ×${p.keepAlives}${limit}` : ''
      return [{ text: `keep-alive${count} →${settings.untilText}`, dim: true }]
    }
    case 'compact':
      return [{ text: 'compact on expiry', dim: true }]
    default:
      return undefined
  }
}

// The keep-alive's inputs from session state, for the tick and the footer alike.
async function planInput($: EngineInterface, settings: Settings, now: number, usage: SessionUsage): Promise<PlanInput> {
  return {
    inWorkHours: inWorkTime(now, settings),
    keepAlives: await read($, keepAlivesAtom),
    maxIdlePings: settings.maxIdlePings,
    lastHumanAt: await read($, lastHumanAtAtom),
    compactedAt: await read($, compactedAtAtom),
    compactCold: await read($, compactColdAtom),
    contextTokens: usage.context.tokens,
    minCompactTokens: settings.minCompactTokens,
  }
}

// Module scope on purpose: a reload drops it with the old module, and one action at a time is enough.
let acting = false
// One log write at a time, so a ping's line and a turn's don't overwrite each other.
let logQueue: Promise<void> = Promise.resolve()
let logFailed = false

async function logDir($: EngineInterface): Promise<string | undefined> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) {
    return `${configDir}/logs/usage`
  }
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/logs/usage` : undefined
}

// Appends a record to <config>/logs/usage/<local date>-<session id>.jsonl. $.fs has no append, so
// the file is read and written whole; one file per session and day keeps it small and unshared.
function appendLog($: EngineInterface, settings: Settings, record: LogRecord): Promise<void> {
  if (!settings.logUsage) {
    return logQueue
  }
  logQueue = logQueue
    .then(async () => {
      const dir = await logDir($)
      if (dir === undefined) {
        return
      }
      const session = await $.session.id()
      const path = `${dir}/${localDate(record.t, settings.utcOffsetMinutes)}-${session}.jsonl`
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      await $.fs.write(path, `${old}${JSON.stringify({ ...record, session })}\n`)
    })
    .catch((error: unknown) => {
      if (!logFailed) {
        logFailed = true
        $.ui.log(`usage-footer: cannot write the usage log (${String(error)}); further failures are not shown`)
      }
    })
  return logQueue
}

// What one tick acts on: when, and the countdown and meter it saw.
type Tick = { now: number; at: string; lastRequestAt: number; meterBefore: number | undefined }

// One tick of the keep-alive: ping, compact, or nothing (see decide()).
async function act($: EngineInterface, settings: Settings) {
  if (!settings.keepAlive || acting) {
    return
  }
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const p = await planInput($, settings, now, usage)
  const lastRequestAt = await read($, lastRequestAtAtom)
  const decision = decide({
    ...p,
    now,
    lastRequestAt,
    ttlMs: settings.ttlMs,
    busy: await read($, busyAtom),
    paused: (await read($, pausedByAtom)) !== null,
  })
  if (decision === 'none' || lastRequestAt === null) {
    return
  }

  acting = true
  const tick = { now, at: hhmm(localMinutes(now, settings.utcOffsetMinutes)), lastRequestAt, meterBefore: fiveHourUsed(usage) }
  try {
    if (decision === 'ping') {
      await ping($, settings, tick)
    } else {
      await compact($, settings, tick, p.inWorkHours ? `idle after ${p.keepAlives} pings` : 'idle outside work hours')
    }
  } finally {
    acting = false
    $.ui.invalidate('ui.render')
  }
}

async function ping($: EngineInterface, settings: Settings, t: Tick) {
  // The cache lifetime counts from the request start, so the countdown restarts now. Put back
  // below when nothing was billed, and only while it is still ours: a turn that started
  // meanwhile has recorded a newer request.
  await update($, lastRequestAtAtom, () => t.now)
  const putBack = (value: number | null) => update($, lastRequestAtAtom, current => (current === t.now ? value : current))

  let reply: ForkReply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    reply = { isAnswered: false, reason: String(error) }
  }
  const outcome = pingOutcome(reply)
  const after = await $.session.usage()
  const cost = costNote(reply.usage, t.meterBefore, fiveHourUsed(after))
  await appendLog($, settings, logRecord('ping', t.now, reply.usage, after, { outcome }))

  if (outcome === 'warm') {
    await update($, failuresAtom, () => 0)
    await update($, keepAlivesAtom, n => n + 1)
    $.ui.log(`usage-footer: keep-alive ping at ${t.at}: ${cost}`)
  } else if (outcome === 'cold') {
    // The ping rebuilt the cache instead of refreshing it: the real lifetime is shorter
    // than cacheTtlMinutes (e.g. 5m during usage overage). Further pings would each cost
    // a full rebuild, so stop until the user is back.
    await update($, failuresAtom, () => 0)
    await update($, pausedByAtom, () => 'cold')
    $.ui.log(
      `usage-footer: keep-alive ping at ${t.at} found the cache already cold (${cost}); the cache lifetime looks shorter than ` +
        `${Math.round(settings.ttlMs / MINUTE_MS)} min, so keep-alive is paused until your next message`,
    )
  } else if (outcome === 'nothing-to-fork') {
    // No response since /clear: nothing to keep warm.
    await putBack(null)
    $.ui.log(`usage-footer: keep-alive at ${t.at}: nothing to keep warm since /clear`)
  } else {
    await putBack(t.lastRequestAt)
    const reason = reply.isAnswered ? 'nothing billed' : reply.reason
    const failures = await update($, failuresAtom, n => n + 1)
    if (failures >= MAX_FAILED_PINGS) {
      await update($, pausedByAtom, () => 'failed')
      $.ui.log(
        `usage-footer: keep-alive ping at ${t.at} failed (${reason}), ${failures} in a row; keep-alive is paused until your next message`,
      )
    } else {
      $.ui.log(`usage-footer: keep-alive ping at ${t.at} failed (${reason})`)
    }
  }
}

// Skipped or failed compactions are not retried until the user types again.
async function compact($: EngineInterface, settings: Settings, t: Tick, why: string) {
  let result: SessionCompactResult | string
  try {
    result = await $.session.compact()
  } catch (error) {
    result = `failed (${String(error)})`
  }
  const done = await $.clock.now()
  await update($, compactedAtAtom, () => done)
  if (typeof result === 'string' || result.messages === undefined) {
    $.ui.log(`usage-footer: compaction at ${t.at} ${typeof result === 'string' ? result : `skipped (${result.skip})`}`)
    return
  }

  // The compacted conversation has no cache yet; keep a newer request a turn recorded meanwhile.
  await update($, lastRequestAtAtom, current => (current === t.lastRequestAt ? null : current))
  await update($, keepAlivesAtom, () => 0)
  const u = result.usage
  const after = await $.session.usage()
  const cost = costNote(u, t.meterBefore, fiveHourUsed(after))
  await appendLog(
    $,
    settings,
    logRecord('compact', t.now, u, after, { trigger: 'keepalive', tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }),
  )
  const details = cost === '' ? '' : ` (${cost})`
  if (u !== undefined && billedInput(u) > 0 && wasCacheCold(u)) {
    // The summary request did not share the conversation's cache, so it cost about as much as
    // the rebuild it was meant to avoid: don't repeat it in this session.
    await update($, compactColdAtom, () => true)
    $.ui.log(`usage-footer: compacted at ${t.at}, ${why}, but the cache was cold${details}; no more automatic compactions in this session`)
  } else {
    $.ui.log(`usage-footer: compacted at ${t.at}, ${why}${details}`)
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
      await update($, failuresAtom, () => 0)
      await update($, pausedByAtom, () => null)
    }
    return next(e)
  })

  // Main-thread turns only: a subagent's run raises no turn.start.
  on('turn.start', async ($, e, next) => {
    await update($, busyAtom, () => true)
    return next(e)
  })

  // The API measures the cache lifetime from the start of the request that last read
  // or wrote the entry, so record the time before the request is sent. Subagents'
  // requests count on the plan's meters too, so the usage log has them as well.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, lastRequestAtAtom, () => startedAt)
      await update($, modelAtom, () => e.model)
      if (e.effort !== undefined) {
        const effort = String(e.effort)
        await update($, effortAtom, () => effort)
      }
      $.ui.invalidate('ui.render')
    }
    const result = yield* next(e)
    if (settings.logUsage && result.usage) {
      const extra = { agent: e.agentId !== undefined, model: result.usage.model }
      await appendLog($, settings, logRecord('request', startedAt, result.usage, await $.session.usage(), extra))
    }
    return result
  })

  // Raised however the turn ended: answered, interrupted, refused or failed.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, busyAtom, () => false)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // A compaction the user or the engine ran (the mod's own calls skip this hook): the
  // compacted conversation has no cache yet, and a ping would only re-read the old one.
  on('session.compact', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    if (result.messages === undefined) {
      return result
    }
    if (e.agentId === undefined && e.trigger !== 'precompute') {
      await update($, lastRequestAtAtom, () => null)
      $.ui.invalidate('ui.render')
    }
    if (settings.logUsage) {
      const extra = { trigger: e.trigger, agent: e.agentId !== undefined, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }
      await appendLog($, settings, logRecord('compact', startedAt, result.usage, await $.session.usage(), extra))
    }
    return result
  }).catch(($, e, next) => next(e)) // the compaction's own result, never run twice

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const segments = buildSegments(
      usage,
      // Last main-thread request's model (opusplan switches in plan mode); the configured one until the first.
      modelName((await read($, modelAtom)) ?? (await $.session.model())),
      (await read($, effortAtom)) ?? undefined,
      (await read($, lastRequestAtAtom)) ?? undefined,
      now,
      settings.ttlMs,
      { fiveHour: settings.showFiveHour, week: settings.showWeek },
    )
    const keepAlive = keepAliveSegment(settings, await planInput($, settings, now, usage), await read($, pausedByAtom))
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
