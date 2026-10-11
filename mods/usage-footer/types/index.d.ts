export type Effort = string

declare module 'claude-code' {
  interface PluginState {
    'usage-footer': {
      lastRequestAt: number | null
      effort: Effort | null
      busy: boolean
      lastHumanAt: number | null
      compactedAt: number | null
      keepAlives: number
      paused: boolean
    }
  }
}
