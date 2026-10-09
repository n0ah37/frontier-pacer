/**
 * One rate-limit window. `kind` is the engine's (`five_hour`, `seven_day`, `seven_day_sonnet`),
 * or `weekly:<model>` for a week scoped to one model, as /usage lists it.
 */
export type Limit = { kind: string; percentUsed: number; resetsAt: string | null }

/**
 * One window as last read, from either source: the account usage endpoint /usage reads, or the
 * rate-limit headers of a response. `at` is when it was read, in milliseconds since the epoch.
 * The endpoint's figure is /usage's own, so a header reading wins only once it is minutes newer.
 */
export type Reading = Limit & { at: number; /** Absent means the endpoint. */ source?: 'endpoint' | 'headers' }

/**
 * The usage figures every session of this plugin shares through the plugin's store: the newest
 * reading of each window, and when the endpoint may next be asked.
 */
export type Shared = {
  readings: Reading[]
  /** When a session last asked the endpoint, so the others wait their turn. */
  askedAt?: number
  /** Not before this time: the endpoint answered 429. */
  retryAt?: number
  /** 429s in a row, which doubles the wait each time. */
  strikes?: number
}

/** The session's figures, as `session.measure` pushes them. */
export type Meter = {
  /** Input tokens the last main-thread response was answered over; null before the first. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number
  limits: Limit[]
  /** What the session has cost so far in US dollars, as /cost totals it; null where the host keeps no ledger. */
  usd: number | null
}

/** When the main thread's cached prefix was last read, and for how long the API keeps it. */
export type CacheMark = {
  /** When the last main-thread request went out, in milliseconds since the epoch. */
  at: number
  /** The lifetime the last response's cache write used; null until one is seen. */
  ttl: '5m' | '1h' | null
}

/**
 * Time the model spent working, as the desktop's usage panel counts it: the turns this Claude Code
 * process has run (from a prompt to the last thing the turn wrote), the running one included.
 * `doneMs` sums those the transcript holds; `closedMs` all but the last, which may still run;
 * `from` is when the process started, or null where it could not be read (then every turn counts).
 */
export type Active = { doneMs: number; closedMs: number; lastPromptAt: number | null; since: number | null; from: number | null }

declare module 'claude-code' {
  interface PluginState {
    'frontier-pacer': {
      meter: Meter | null
      cache: CacheMark | null
      transcript: string | null
      /** The newest reading of each window this session holds. */
      readings: Reading[]
      /** The main thread's model id, as the last request named it. */
      model: string | null
      active: Active | null
      tick: number
      /** Whether /pace has hidden the band in this session. */
      hidden: boolean
    }
  }
}
