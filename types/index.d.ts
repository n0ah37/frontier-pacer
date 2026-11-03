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

/** The session's figures, as `session.measure` pushes them and `$.session.usage()` answers. */
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
  /** When the last main-thread request (a turn's, or a compaction's) went out, in milliseconds since the epoch. */
  at: number
  /** The lifetime the session's cache writes use; null until a response or an environment variable says. */
  ttl: '5m' | '1h' | null
}

/**
 * Time the model spent on the session's main-thread turns, as the engine times each turn (the
 * desktop's usage panel sums the same lengths). Every process that runs the session adds to one
 * total kept in the plugin's store under `active:<session id>`, so a paused and restarted session
 * keeps counting where it stopped.
 */
export type Active = {
  /** The session the figures belong to; null until read, and again after /clear or /resume. */
  sessionId: string | null
  /** The turns finished before this load: the stored total, or the first time the transcript's; null until read. */
  baseMs: number | null
  /**
   * Whether `baseMs` holds the session's earlier turns. False when the transcript could not be read
   * whole: the total is then not stored, and the next process of the session reads it again.
   */
  hasHistory: boolean
  /** The turns this load saw finish, at the lengths the engine reported. */
  runMs: number
  /** When the running main-thread turn began, as `turn.start` saw it; null between turns. */
  since: number | null
  /** When this load began counting: the transcript's turns are read up to here and no further. */
  loadedAt: number
}

/** One session's total as the store keeps it. */
export type StoredActive = {
  /** Every finished main-thread turn's length, summed. */
  ms: number
  /** When it was last written, so totals of long-gone sessions can be dropped. */
  at: number
}

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
