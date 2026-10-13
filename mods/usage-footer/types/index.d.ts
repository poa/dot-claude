export type Effort = string
// Why keep-alive stopped until the user's next message: a ping found the cache cold, or pings kept failing.
export type PauseReason = 'cold' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'usage-footer': {
      lastRequestAt: number | null
      effort: Effort | null
      busy: boolean
      lastHumanAt: number | null
      compactedAt: number | null
      keepAlives: number
      pausedBy: PauseReason | null
      failures: number
      compactCold: boolean
    }
  }
}
