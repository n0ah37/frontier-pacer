import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { Active, Limit, Meter, Reading, Shared, StoredActive } from '../types'

const meter = atom({ plugin: 'frontier-pacer', key: 'meter' } as const, null)
const cache = atom({ plugin: 'frontier-pacer', key: 'cache' } as const, null)
const transcript = atom({ plugin: 'frontier-pacer', key: 'transcript' } as const, null)
const readings = atom({ plugin: 'frontier-pacer', key: 'readings' } as const, [])
const model = atom({ plugin: 'frontier-pacer', key: 'model' } as const, null)
const active = atom({ plugin: 'frontier-pacer', key: 'active' } as const, null)
const tick = atom({ plugin: 'frontier-pacer', key: 'tick' } as const, 0)
const hidden = atom({ plugin: 'frontier-pacer', key: 'hidden' } as const, false)

type Ttl = '5m' | '1h'

const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// The windows /usage draws, in its order, with CodexBar's wording for running out.
const LANES = [
  { kind: 'five_hour', label: '5h', minutes: 300, runsOut: 'empty in' },
  { kind: 'seven_day', label: '7d', minutes: 10_080, runsOut: 'out in' },
  { kind: 'seven_day_sonnet', label: '7d Sonnet', minutes: 10_080, runsOut: 'out in' },
] as const

type Lane = { kind: string; label: string; minutes: number; runsOut: string; model?: string }

// Every session of this plugin shares its readings through the plugin's store, so each band shows
// the newest figure of each window that any session read: from a response's rate-limit headers
// (every response) or from the usage endpoint. The endpoint rate-limits hard and its limit is shared
// with Claude Code's own polling, so all sessions together ask it at most once a minute, honour
// its Retry-After, and double the wait after each 429 in a row.
const USAGE_EVERY_MS = 60_000
const USAGE_MIN_GAP_MS = 60_000
const USAGE_BACKOFF_MS = 5 * 60_000
const USAGE_BACKOFF_MAX_MS = 60 * 60_000
const SHARED_EVERY_MS = 5_000
// Version 0.2 kept one reading under `usage`; sessions still running it rewrite that key, so the
// readings live under their own.
const SHARED_KEY = 'readings'

// CodexBar's Claude tint, and SwiftUI's .red and .green for its pace colours.
const CLAUDE = '#CC7C5E'
const RED = '#FF3B30'
const GREEN = '#34C759'

const TICK_MS = 1000
// The engine's ledger is read again this often, so a figure the engine settled without a
// measurement (a restored session, a compaction's own request) shows within seconds.
const USAGE_READ_EVERY_TICKS = 5
const TAIL_BYTES = 1024 * 1024
const RING_PX = 16
const RING_STROKE = 2.5
// Columns between two figures on the line.
const GAP = 2
const COMMAND = 'pace'
// Partial circles from empty to full, for the terminal, which draws no SVG.
const GLYPHS = ['○', '◔', '◑', '◕', '●'] as const

// Finds this session's transcript under every project folder, whatever the cwd was sanitised to.
const FIND_TRANSCRIPT =
  'for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do [ -f "$f" ] && { echo "$f"; break; }; done'

// Whether this load of the module has started its timers: a hot reload mid-session raises no
// session.start, so the first event after one starts them.
let isRunning = false

// On Vertex, Bedrock or Foundry there is no plan, so no 5h or 7d window to ask for or draw; null
// until the environment has been read, and nothing of the plan is drawn or asked for until then.
let isCloud: boolean | null = null
// The cache lifetime an environment variable pins; these outrank every setting, as the engine
// reads them. Without one the lifetime waits for the first response that wrote the cache.
let pinnedTtl: Ttl | null = null

async function learnEnv($: EngineInterface): Promise<void> {
  const flags = [
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ]
  const on = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  const ttl = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  pinnedTtl = on(await $.env.get('FORCE_PROMPT_CACHING_5M')) ? '5m' : ttl === '5m' || ttl === '1h' ? ttl : null
  isCloud = flags.some(on)
}

// A debug log, off unless the folder `frontier-pacer-debug` exists in the Claude configuration
// directory: then each session writes there what the band drew and the figures it drew it from,
// one JSON line each (numbers and event names only), the newest 500 lines per session.
let debugDir: string | null = null
const debugLines: string[] = []
let lastDrawn = ''

async function learnDebug($: EngineInterface): Promise<void> {
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    const dir = `${config}/frontier-pacer-debug`
    debugDir = (await $.fs.stat(dir)).kind === 'dir' ? dir : null
  } catch {
    debugDir = null
  }
}

async function debug($: EngineInterface, event: string, data: Record<string, unknown> = {}): Promise<void> {
  if (debugDir === null) {
    return
  }
  try {
    const at = await $.clock.now()
    const id = await $.session.id()
    debugLines.push(JSON.stringify({ at: new Date(at).toISOString(), session: id, event, ...data }))
    debugLines.splice(0, Math.max(0, debugLines.length - 500))
    await $.fs.write(`${debugDir}/${id}.jsonl`, `${debugLines.join('\n')}\n`)
  } catch {
    // Nothing to log to.
  }
}

function run($: EngineInterface): void {
  if (isRunning) {
    return
  }

  isRunning = true
  $.clock.after(1, () => void boot($))
  let ticks = 0
  $.clock.every(TICK_MS, () => {
    ticks += 1
    void pulse($)
    if (ticks % USAGE_READ_EVERY_TICKS === 0) {
      void readLedger($)
      // The response that says the lifetime can reach the transcript a moment after its turn ends.
      void read($, cache).then(mark => (mark !== null && mark.ttl === null ? learnTtl($, false) : undefined))
    }
  })
  $.clock.every(USAGE_EVERY_MS, () => void fetchUsage($))
  $.clock.every(SHARED_EVERY_MS, () => void adoptShared($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    run($)

    return started
  })

  on('session.measure', async ($, e, next) => {
    run($)
    const m = toMeter(e.context, e.rateLimits, e.cost?.usd)
    await update($, meter, () => m)
    void debug($, 'measure', { changed: e.changed, usd: m.usd, tokens: m.tokens })
    // A response landed (it cost something, or moved a window): its headers are the newest reading.
    if (isCloud === false && (e.changed.includes('cost') || e.changed.includes('rateLimits'))) {
      const at = await $.clock.now()
      await share($, m.limits.map(limit => ({ ...limit, at, source: 'headers' as const })))
      void fetchUsage($)
    }

    return next(e)
  })

  // A main-thread turn starts counting live; its end adds the engine's own length of it.
  on('turn.start', async ($, e, next) => {
    run($)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, active, a => ({ ...(a ?? freshActive(at)), since: at }))
    }

    return next(e)
  })

  // A main-thread request reads the cached prefix, which starts its lifetime over.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, cache, mark => ({ at, ttl: mark?.ttl ?? null }))
      await update($, model, () => e.model)
    }

    const response = yield* next(e)
    // Until a response has said which lifetime the session's writes use, each one is read for it.
    if (e.agentId === undefined && (await read($, cache))?.ttl == null) {
      void learnTtl($, false)
    }

    return response
  })

  // The response records which lifetime its cache write used.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      // The engine's own length of the turn, to the millisecond, as its "Cogitated for" line reads.
      // A turn already running when this load began was read from the transcript up to that moment,
      // so only its part since then is added.
      await update($, active, a => {
        const held = a ?? freshActive(at)
        const counted = held.since !== null ? e.durationMs : Math.min(e.durationMs, Math.max(0, at - held.loadedAt))

        return { ...held, runMs: held.runMs + counted, since: null }
      })
      void debug($, 'turn.complete', { durationMs: e.durationMs, reason: e.reason })
      await saveActive($)
      await learnTtl($, false)
      void fetchUsage($)
    }

    return done
  })

  // A compaction's own request reads the main thread's cached prefix too. Afterwards the
  // conversation is shorter, and the next request writes what it no longer shares.
  on('session.compact', async ($, e, next) => {
    const at = await $.clock.now()
    const done = await next(e)
    if (e.agentId === undefined && done.skip === undefined && done.usage !== undefined) {
      await update($, cache, mark => (mark === null ? { at, ttl: null } : { ...mark, at: Math.max(mark.at, at) }))
      void debug($, 'compact', { trigger: e.trigger, tokensAfter: done.tokensAfter ?? null })
      void readLedger($)
    }

    return done
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, cache, () => null)
    void learnModel($)

    return next(e)
  })

  // /clear starts a new session in the same process, and /resume takes up another: the figures
  // that belong to one session start over, then the new one's are read.
  on('session.end', async ($, e, next) => {
    const isSwitch = e.reason === 'clear' || e.reason === 'resume'
    if (isSwitch) {
      await update($, cache, () => null)
      await update($, transcript, () => null)
      await update($, meter, m => (m === null ? m : { ...m, tokens: null }))
      const at = await $.clock.now()
      // A cleared session has no turns yet; a resumed one has its own, read below.
      await update($, active, () => (e.reason === 'clear' ? { ...freshActive(at), baseMs: 0, hasHistory: true } : freshActive(at)))
    }

    const ended = await next(e)
    void debug($, 'session.end', { reason: e.reason })
    if (isSwitch) {
      $.clock.after(1, () => void relearn($, e.reason === 'resume'))
    }

    return ended
  })

  // /pace hides the band or brings it back; /pace on and /pace off set it.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isHidden = arg === 'off' || arg === 'hide' ? true : arg === 'on' || arg === 'show' ? false : !(await read($, hidden))
    await update($, hidden, () => isHidden)

    return { text: isHidden ? 'Usage band hidden. /pace shows it again.' : 'Usage band shown. /pace hides it.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) {
      return next(e)
    }

    await read($, tick)
    const m = await read($, meter)
    const mark = await read($, cache)
    const held = await read($, readings)
    const modelId = (await read($, model))?.toLowerCase() ?? ''
    const worked = await read($, active)
    if (m === null && mark === null) {
      return next(e)
    }

    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    // Only the desktop draws SVG; the terminal gets partial-circle glyphs.
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined
    const ringColumns = Svg !== undefined ? 2 : 1
    const ring = (key: string, gauge: Gauge, alt: string) =>
      Svg !== undefined ? (
        <Svg key={key} source={ringSvg(gauge)} alt={alt} width={RING_PX} height={RING_PX} />
      ) : (
        <Text key={key} color={gauge.color} bold>
          {glyphOf(gauge.fraction)}
        </Text>
      )
    const items: Item[] = []

    if (m?.tokens != null) {
      const text = tokensText(m.tokens)
      items.push({ key: 'context', rank: 4, columns: 4 + text.length, node: (
        <Box key="context" flexDirection="row" columnGap={1}>
          <Text dimColor>ctx</Text>
          <Text bold>{text}</Text>
        </Box>
      ) })
    }
    if (m?.usd != null) {
      const text = usdText(m.usd)
      items.push({ key: 'cost', rank: 6, columns: text.length, node: <Text key="cost" bold>{text}</Text> })
    }
    const activeMs = activeOf(worked, now)
    if (activeMs !== null) {
      const text = durationText(activeMs)
      items.push({ key: 'active', rank: 7, columns: 7 + text.length, node: (
        <Box key="active" flexDirection="row" columnGap={1}>
          <Text dimColor>active</Text>
          <Text bold>{text}</Text>
        </Box>
      ) })
    }

    // The lifetime left since the last main-thread request read the cache. Each request starts it
    // over, so while Claude works it stays near full, and a long tool run or compaction counts down
    // as the cache really ages. Until the lifetime is known it is not drawn rather than guessed.
    const ttl = mark === null ? null : (mark.ttl ?? pinnedTtl)
    const remaining = mark === null || ttl === null ? null : Math.min(TTL_MS[ttl], mark.at + TTL_MS[ttl] - now)
    if (ttl !== null && remaining !== null) {
      // The last tenth of the lifetime (6 minutes of the hour) is when a prompt still lands warm.
      const isLastTenth = remaining < TTL_MS[ttl] / 10
      const gauge: Gauge = { fraction: clamp(remaining / TTL_MS[ttl], 0, 1), color: isLastTenth ? RED : CLAUDE }
      const text = remaining <= 0 ? 'expired' : timerText(remaining)
      items.push({ key: 'cache', rank: 3, columns: 6 + ringColumns + 1 + text.length, node: (
        <Box key="cache" flexDirection="row" alignItems="center" columnGap={1}>
          <Text dimColor>cache</Text>
          {ring('cache-ring', gauge, remaining > 0 ? `cache warm for ${text}` : 'cache expired')}
          {remaining <= 0 || isLastTenth ? <Text color={RED} bold>{text}</Text> : <Text bold>{text}</Text>}
        </Box>
      ) })
    }

    // The newest reading of each window; until any, the headers the engine held at load.
    const limits = isCloud !== false ? [] : (held.length > 0 ? held : (m?.limits ?? [])).map(limit => current(limit, now))
    for (const limit of limits) {
      const lane = laneOf(limit.kind)
      // A week scoped to one model shows while the session runs that model.
      if (lane === null || (lane.model !== undefined && !modelId.includes(lane.model.toLowerCase()))) {
        continue
      }

      // /usage floors: 7.9% reads 7% used.
      const used = Math.floor(clamp(limit.percentUsed, 0, 100))
      const pace = shownPace(limit, lane.minutes, now)
      const paceColor = pace === null || pace.stage === 'onTrack' ? undefined : pace.delta > 0 ? RED : GREEN
      const delta = pace === null ? null : paceText(pace.delta)
      // The ring shows the figure printed beside it.
      const gauge: Gauge = { fraction: used / 100, color: used >= 100 ? RED : CLAUDE }
      const alt = `${lane.label} ${used}% used${delta === null ? '' : `, ${delta} against pace`}`
      const usedText = `${used}%`
      items.push({
        key: lane.kind,
        rank: lane.model === undefined ? (lane.kind === 'five_hour' ? 1 : 2) : 5,
        columns: lane.label.length + 1 + ringColumns + 1 + usedText.length + (delta === null ? 0 : 1 + delta.length),
        node: (
          <Box key={lane.kind} flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>{lane.label}</Text>
            {ring(`${lane.kind}-ring`, gauge, alt)}
            <Text bold>{usedText}</Text>
            {delta !== null &&
              (paceColor === undefined ? <Text dimColor>{delta}</Text> : <Text color={paceColor}>{delta}</Text>)}
          </Box>
        ),
      })

      // Within 2 points of an even pace the projection is noise (two hours into a week), so it stays quiet.
      if (pace !== null && pace.stage !== 'onTrack' && !pace.lastsToReset && pace.etaMs !== null) {
        const eta = pace.etaMs === 0 ? `${lane.runsOut} now` : `${lane.runsOut} ${countdown(pace.etaMs)}`
        items.push({ key: `${lane.kind}-eta`, rank: 8, columns: eta.length, node: <Text key={`${lane.kind}-eta`} color={RED}>{eta}</Text> })
      }
    }

    if (debugDir !== null) {
      const drawn = JSON.stringify({ usd: m?.usd ?? null, tokens: m?.tokens ?? null, active: activeMs === null ? null : Math.floor(activeMs / 60_000), ttl, cacheMinutes: remaining === null ? null : Math.ceil(remaining / 60_000), isWorking: e.props.isWorking, shown: fit(items, e.props.bodyColumns).map(item => item.key) })
      if (drawn !== lastDrawn) {
        lastDrawn = drawn
        void debug($, 'drawn', JSON.parse(drawn) as Record<string, unknown>)
      }
    }
    if (items.length === 0) {
      return next(e)
    }

    return (
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={GAP}>
        {fit(items, e.props.bodyColumns).map(item => item.node)}
      </Box>
    )
  })
}

type Item = {
  key: string
  /** Which figure goes first when the line is short: 1 stays longest. */
  rank: number
  /** How many columns it takes. */
  columns: number
  node: RenderChildren
}

// Keeps the figures in their order on one line, leaving out the least needed until the line fits.
function fit(items: readonly Item[], columns: number): Item[] {
  const width = (kept: readonly Item[]) => kept.reduce((sum, item) => sum + item.columns, 0) + GAP * Math.max(0, kept.length - 1)
  let kept = [...items]
  const byNeed = [...items].sort((a, b) => b.rank - a.rank)
  for (const item of byNeed) {
    if (!(columns > 0) || width(kept) <= columns || kept.length === 1) {
      break
    }
    kept = kept.filter(k => k !== item)
  }

  return kept
}

// Redraws each second: the cache timer and the active clock both count seconds.
async function pulse($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

async function boot($: EngineInterface): Promise<void> {
  await learnEnv($)
  await learnDebug($)
  try {
    await $.command.register({ name: COMMAND, description: 'Hide or show the usage band (on, off)', argumentHint: '[on|off]', immediate: true })
  } catch {
    // A host without slash commands: the band always shows.
  }
  await relearn($, true)
  await learnModel($)
  await fetchUsage($)
  void forgetOldTotals($)
}

// Reads what belongs to the session the process now runs: the ledger, the cache's last read and
// lifetime from the transcript, and the time already worked.
async function relearn($: EngineInterface, isSeeded: boolean): Promise<void> {
  try {
    const usage = await $.session.usage()
    await update($, meter, () => toMeter(usage.context, usage.rateLimits, usage.cost?.usd))
    void debug($, 'load', { usd: usage.cost?.usd ?? null, tokens: usage.context.tokens ?? null, isCloud, pinnedTtl })
  } catch {
    // The next measurement fills it.
  }
  await learnTtl($, isSeeded)
  await learnActive($)
}

// The engine's ledger as /cost totals it. A measurement comes after each main-thread turn; this
// catches what moved without one, so the figure never sits on a stale value for long.
async function readLedger($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    const usd = usage.cost?.usd
    if (usd === undefined) {
      return
    }
    if ((await read($, meter))?.usd !== usd) {
      void debug($, 'ledger', { usd, tokens: usage.context.tokens ?? null })
    }
    await update($, meter, m =>
      m === null ? toMeter(usage.context, usage.rateLimits, usd) : m.usd === usd && m.tokens !== null ? m : { ...m, usd, tokens: m.tokens ?? usage.context.tokens ?? null },
    )
  } catch {
    // No session bound yet: the next read or measurement fills it.
  }
}

const ACTIVE_KEY = 'active:'
// A session's total is dropped from the store once nobody has run it for this long.
const ACTIVE_KEEP_MS = 90 * 24 * 60 * 60_000
// Inside a turn whose end the transcript does not record (a turn cut short, an event that started
// one without a prompt), a pause this long with no tool running ends it.
const IDLE_GAP_MS = 30 * 60_000
// Reading a transcript of hundreds of megabytes takes awk half a minute; it is done once a session.
const HISTORY_TIMEOUT_MS = 5 * 60_000

function freshActive(at: number): Active {
  return { sessionId: null, baseMs: null, hasHistory: false, runMs: 0, since: null, loadedAt: at }
}

// Prints the main thread's transcript as rows of kind and time: `U` a prompt or event that can
// start a turn, `T` a response that called a tool, `E` a response that ended the turn, `W` other
// work (a tool's result, a summary). Of the `T` and `W` rows only the last of each minute prints,
// so a long session prints a few hundred kilobytes at most. A row repeated in the file (same uuid)
// counts once, and the engine's own stand-in replies (model `<synthetic>`, written when it closes a
// turn, at times days later) are left out.
const TURN_ROWS = `
function flush() { if (held != "") print held; held = "" }
/"isSidechain":true/ { next }
{
  if (!match($0, /"timestamp":"[^"]*"/)) next
  ts = substr($0, RSTART + 13, RLENGTH - 14)
  if (match($0, /"uuid":"[^"]*"/)) {
    id = substr($0, RSTART + 8, RLENGTH - 9)
    if (id in seen) next
    seen[id] = 1
  }
  kind = ""
  if ($0 ~ /"type":"assistant"/ && $0 ~ /"role":"assistant"/) {
    if ($0 ~ /"model":"<synthetic>"/) next
    if ($0 ~ /"stop_reason":"tool_use"/) kind = "T"
    else if ($0 ~ /"stop_reason":"(end_turn|stop_sequence|max_tokens|refusal)"/) kind = "E"
    else kind = "W"
  } else if ($0 ~ /"type":"user"/ && $0 ~ /"role":"user"/) {
    if ($0 ~ /"tool_result"/ || $0 ~ /"isCompactSummary":true/) kind = "W"
    else kind = "U"
  }
  if (kind == "") next
  if (kind == "U" || kind == "E") { flush(); print kind " " ts; minute = ""; next }
  if (substr(ts, 1, 16) != minute) flush()
  held = kind " " ts
  minute = substr(ts, 1, 16)
}
END { flush() }`

// The time worked before this load: the session's stored total when one is kept, otherwise (its
// first load with this version) the turns the transcript holds, which is then stored.
async function learnActive($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  try {
    const id = await $.session.id()
    const held = await read($, active)
    // A reload of this module keeps the figures it already has for the session.
    if (held !== null && held.sessionId === id && held.baseMs !== null) {
      return
    }

    // /clear has already said its new session starts at nothing.
    const carried = held !== null && held.sessionId === null ? held.baseMs : null
    const loadedAt = held?.loadedAt ?? now
    const base = carried ?? (await storedActive($, id)) ?? (await transcriptActive($, loadedAt))
    await update($, active, a => {
      const current = a ?? freshActive(loadedAt)
      // Figures held for another session never carry over.
      const own = current.sessionId === null || current.sessionId === id ? current : freshActive(now)

      return { ...own, sessionId: id, baseMs: base ?? 0, hasHistory: base !== null }
    })
    await saveActive($)
  } catch {
    await update($, active, a => (a === null ? { ...freshActive(now), baseMs: 0 } : a.baseMs === null ? { ...a, baseMs: 0 } : a))
  }
}

async function storedActive($: EngineInterface, id: string): Promise<number | null> {
  try {
    const value = (await $.store.get(`${ACTIVE_KEY}${id}`)) as StoredActive | undefined

    return value != null && typeof value.ms === 'number' && Number.isFinite(value.ms) && value.ms >= 0 ? value.ms : null
  } catch {
    return null
  }
}

// The transcript's turns; null where it could not be read whole, so nothing partial is stored.
async function transcriptActive($: EngineInterface, until: number): Promise<number | null> {
  try {
    const path = await transcriptPath($)
    if (path === null) {
      return 0
    }
    const result = await $.process.run(['awk', TURN_ROWS, path], { timeoutMs: HISTORY_TIMEOUT_MS })
    if (result.exitCode !== 0 || result.isStdoutTruncated) {
      return null
    }

    return workedMs(result.stdout, until)
  } catch {
    return null
  }
}

// Writes the session's total where every later process of it reads it.
async function saveActive($: EngineInterface): Promise<void> {
  try {
    const worked = await read($, active)
    if (worked === null || worked.baseMs === null || !worked.hasHistory) {
      return
    }
    const id = worked.sessionId ?? (await $.session.id())
    if (worked.sessionId === null) {
      await update($, active, a => (a === null ? a : { ...a, sessionId: id }))
    }
    const value: StoredActive = { ms: worked.baseMs + worked.runMs, at: await $.clock.now() }
    await $.store.set(`${ACTIVE_KEY}${id}`, value)
  } catch {
    // No store (a headless host): the figure lasts as long as the process.
  }
}

async function forgetOldTotals($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(ACTIVE_KEY)) {
        continue
      }
      const value = (await $.store.get(key)) as StoredActive | undefined
      if (value == null || typeof value.at !== 'number' || now - value.at > ACTIVE_KEEP_MS) {
        await $.store.delete(key)
      }
    }
  } catch {
    // Kept until the next start.
  }
}

// Sums the main thread's turns from TURN_ROWS' lines, up to `until`. A turn runs from the row that
// opens it to the response that ends it; a pause longer than IDLE_GAP_MS while no tool runs ends a
// turn the transcript never closed, so idle hours are never counted as work. A turn still running
// at `until` counts to its last row; its end adds the rest (see turn.complete).
function workedMs(rows: string, until: number): number {
  let total = 0
  let start: number | null = null
  let last = 0
  let isToolRunning = false
  const close = () => {
    if (start !== null) {
      total += Math.max(0, Math.min(last, until) - start)
    }
    start = null
    isToolRunning = false
  }
  for (const row of rows.split('\n')) {
    const kind = row.slice(0, 1)
    const at = Date.parse(row.slice(2))
    if (Number.isNaN(at) || !'UTEW'.includes(kind) || kind === '' || at >= until) {
      continue
    }
    if (start !== null && at > last + IDLE_GAP_MS && !isToolRunning) {
      close()
    }
    if (start === null) {
      if (kind === 'E') {
        continue
      }
      start = at
      last = at
    } else {
      last = Math.max(last, at)
    }
    isToolRunning = kind === 'T'
    if (kind === 'E') {
      close()
    }
  }
  close()

  return total
}

// The finished turns, and the running one from the moment its start was seen. Not drawn until the
// session's earlier turns are read, so the figure never starts low and leaps.
function activeOf(worked: Active | null, now: number): number | null {
  if (worked === null || worked.baseMs === null) {
    return null
  }

  return worked.baseMs + worked.runMs + (worked.since === null ? 0 : Math.max(0, now - worked.since))
}

async function learnModel($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.model()
    await update($, model, () => id)
  } catch {
    // The next main-thread request names it.
  }
}

function laneOf(kind: string): Lane | null {
  const known = LANES.find(lane => lane.kind === kind)
  if (known !== undefined) {
    return known
  }
  if (kind.startsWith('weekly:')) {
    const name = kind.slice('weekly:'.length)

    return { kind, label: `7d ${name}`, minutes: 10_080, runsOut: 'out in', model: name }
  }

  return null
}

type UsageWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined

type UsageBody = {
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_sonnet?: UsageWindow
  limits?: Array<{ kind?: string; percent?: number | null; resets_at?: string | null; scope?: { model?: { display_name?: string } } }>
}

// A window whose reset has passed starts over at nothing used, until a reading says otherwise.
function current(limit: Limit, now: number): Limit {
  const resetsAt = limit.resetsAt === null ? NaN : Date.parse(limit.resetsAt)

  return resetsAt <= now ? { ...limit, percentUsed: 0, resetsAt: null } : limit
}

// A response's headers can trail /usage by a point, so they stand in only once the endpoint's
// reading is this much older than theirs.
const HEADERS_LAG_MS = 3 * 60_000

function weight(reading: Reading): number {
  return reading.source === 'headers' ? reading.at - HEADERS_LAG_MS : reading.at
}

// The better reading of each window from both lists (the second on a tie); a window either lacks is kept.
function merge(mine: readonly Reading[], theirs: readonly Reading[]): Reading[] {
  const byKind = new Map<string, Reading>()
  for (const reading of [...mine, ...theirs]) {
    const held = byKind.get(reading.kind)
    if (held === undefined || weight(reading) >= weight(held)) {
      byKind.set(reading.kind, reading)
    }
  }

  return [...byKind.values()]
}

function isReading(value: unknown): value is Reading {
  const r = value as Reading | null
  return r != null && typeof r.kind === 'string' && typeof r.percentUsed === 'number' && typeof r.at === 'number'
}

// What every session shares; empty when nothing is stored.
async function readShared($: EngineInterface): Promise<Shared> {
  try {
    const value = (await $.store.get(SHARED_KEY)) as Shared | undefined
    if (value == null) {
      return { readings: [] }
    }

    return {
      readings: Array.isArray(value.readings) ? value.readings.filter(isReading) : [],
      askedAt: typeof value.askedAt === 'number' ? value.askedAt : undefined,
      retryAt: typeof value.retryAt === 'number' ? value.retryAt : undefined,
      strikes: typeof value.strikes === 'number' ? value.strikes : undefined,
    }
  } catch {
    return { readings: [] }
  }
}

// Re-reads the store just before writing, so a reading another session stored a moment ago survives.
async function writeShared($: EngineInterface, change: (shared: Shared) => Shared): Promise<void> {
  try {
    await $.store.set(SHARED_KEY, change(await readShared($)))
  } catch {
    // No store (a headless host): this session keeps its own readings.
  }
}

// Takes this session's new readings and every newer one stored by another session.
async function share($: EngineInterface, fresh: readonly Reading[]): Promise<void> {
  await update($, readings, mine => merge(mine, fresh))
  await writeShared($, shared => ({ ...shared, readings: merge(shared.readings, fresh) }))
  await adoptShared($)
}

async function adoptShared($: EngineInterface): Promise<Shared> {
  const shared = await readShared($)
  if (shared.readings.length > 0) {
    await update($, readings, mine => merge(mine, shared.readings))
  }

  return shared
}

// Reads the windows /usage shows: the session, the week across models, Sonnet's week, and each week
// scoped to one model. A failure keeps the last readings, which the next response's headers refresh.
async function fetchUsage($: EngineInterface): Promise<void> {
  if (isCloud !== false) {
    return
  }
  try {
    const now = await $.clock.now()
    const shared = await adoptShared($)
    if (shared.retryAt !== undefined && now < shared.retryAt) {
      return
    }
    if (shared.askedAt !== undefined && now - shared.askedAt < USAGE_MIN_GAP_MS) {
      return
    }

    const auth = await $.session.authorize()
    if (auth === null || auth.kind !== 'bearer') {
      return
    }

    // Claims the turn before asking, so the other sessions wait.
    await writeShared($, s => ({ ...s, askedAt: now }))
    // The account usage endpoint /usage reads; the engine's own credential rides the request.
    // It answers only Claude Code: without its User-Agent every request gets 429 with an hour's
    // Retry-After, however rarely it is asked.
    const { base, version } = await $.session.version()
    const response = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: {
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `claude-code/${base ?? version}`,
      },
    })
    if (response.status === 429) {
      // Rate limited: every session waits, as long as the endpoint asks or longer each time.
      await writeShared($, s => {
        const strikes = (s.strikes ?? 0) + 1
        const backoff = Math.min(USAGE_BACKOFF_MAX_MS, USAGE_BACKOFF_MS * 2 ** (strikes - 1))
        const asked = retryAfterMs(response.headers['retry-after'])

        return { ...s, strikes, retryAt: now + Math.max(backoff, asked) }
      })

      return
    }
    if (!response.ok) {
      return
    }

    const limits = officialLimits(JSON.parse(response.text) as UsageBody)
    await writeShared($, s => ({ ...s, retryAt: undefined, strikes: undefined }))
    if (limits.length > 0) {
      await share($, limits.map(limit => ({ ...limit, at: now, source: 'endpoint' as const })))
    }
  } catch {
    // Offline, logged out, or a body of another shape: the readings held stand.
  }
}

// Retry-After in seconds; 0 when absent or unreadable (the endpoint has sent `0` while still refusing).
function retryAfterMs(value: string | undefined): number {
  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

function officialLimits(body: UsageBody): Limit[] {
  const out: Limit[] = []
  for (const kind of ['five_hour', 'seven_day', 'seven_day_sonnet'] as const) {
    const window = body[kind]
    if (window != null && typeof window.utilization === 'number') {
      out.push({ kind, percentUsed: window.utilization, resetsAt: window.resets_at ?? null })
    }
  }
  for (const scoped of body.limits ?? []) {
    const name = scoped.scope?.model?.display_name
    if (scoped.kind === 'weekly_scoped' && typeof name === 'string' && typeof scoped.percent === 'number') {
      out.push({ kind: `weekly:${name}`, percentUsed: scoped.percent, resetsAt: scoped.resets_at ?? null })
    }
  }

  return out
}

function toMeter(context: SessionContextUsage, limits: readonly SessionRateLimit[], usd: number | undefined): Meter {
  return {
    tokens: context.tokens ?? null,
    window: context.window,
    limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
    usd: usd ?? null,
  }
}

// Reads the last main-thread response from the transcript: when it landed, and its cache lifetime.
// `seed` sets the anchor from it when this process has not seen a request yet (a resume, a reload).
async function learnTtl($: EngineInterface, seed: boolean): Promise<void> {
  try {
    const path = await transcriptPath($)
    if (path === null) {
      return
    }

    const { stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    const last = lastResponse(stdout)
    if (last === null) {
      return
    }

    await update($, cache, mark => {
      if (mark !== null) {
        return { ...mark, ttl: last.ttl ?? mark.ttl }
      }

      return seed ? { at: last.at, ttl: last.ttl } : null
    })
  } catch {
    // No transcript to read (a headless host, a moved file): the lifetime stays a guess.
  }
}

async function transcriptPath($: EngineInterface): Promise<string | null> {
  const known = await read($, transcript)
  if (known !== null) {
    return known
  }

  const id = await $.session.id()
  const { stdout } = await $.process.run(['/bin/sh', '-c', FIND_TRANSCRIPT, 'sh', id])
  const found = stdout.trim()
  if (found === '') {
    return null
  }

  await update($, transcript, () => found)

  return found
}

function lastResponse(text: string): { at: number; ttl: Ttl | null } | null {
  const lines = text.split('\n')
  let newest: { at: number; ttl: Ttl | null } | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('"assistant"')) {
      continue
    }

    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    const entry = row as {
      type?: string
      isSidechain?: boolean
      timestamp?: string
      message?: { model?: string; usage?: unknown }
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) {
      continue
    }
    if (entry.message?.usage == null || entry.message.model === '<synthetic>') {
      continue
    }

    const at = Date.parse(entry.timestamp ?? '')
    if (Number.isNaN(at)) {
      continue
    }

    // A response that only read the cache says nothing of its lifetime: look further back for one that wrote it.
    const ttl = ttlOf(entry.message.usage)
    newest = newest ?? { at, ttl }
    if (ttl !== null) {
      return { at: newest.at, ttl }
    }
  }

  return newest
}

// The engine's own reading of a response's cache write.
function ttlOf(usage: unknown): Ttl | null {
  const split = (usage as { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } })
    .cache_creation
  if ((split?.ephemeral_1h_input_tokens ?? 0) > 0) {
    return '1h'
  }
  if ((split?.ephemeral_5m_input_tokens ?? 0) > 0) {
    return '5m'
  }

  return null
}

type Stage = 'onTrack' | 'slightlyAhead' | 'ahead' | 'farAhead' | 'slightlyBehind' | 'behind' | 'farBehind'

type Pace = {
  stage: Stage
  delta: number
  expected: number
  actual: number
  etaMs: number | null
  lastsToReset: boolean
}

// UsagePace.weekly from steipete/CodexBar (Sources/CodexBarCore/UsagePace.swift), without the work-day split.
function paceOf(limit: Limit, minutes: number, now: number): Pace | null {
  if (limit.resetsAt === null) {
    return null
  }

  const resetsAt = Date.parse(limit.resetsAt)
  const duration = minutes * 60_000
  const untilReset = resetsAt - now
  if (Number.isNaN(resetsAt) || untilReset <= 0 || untilReset > duration) {
    return null
  }

  const elapsed = clamp(duration - untilReset, 0, duration)
  const expected = clamp((elapsed / duration) * 100, 0, 100)
  const actual = clamp(limit.percentUsed, 0, 100)
  if (elapsed === 0 && actual > 0) {
    return null
  }

  let etaMs: number | null = null
  let lastsToReset = false
  if (actual >= 100) {
    etaMs = 0
  } else if (elapsed > 0 && actual > 0) {
    const toEmpty = (100 - actual) / (actual / elapsed)
    if (toEmpty >= untilReset) {
      lastsToReset = true
    } else {
      etaMs = toEmpty
    }
  } else if (elapsed > 0) {
    lastsToReset = true
  }

  const delta = actual - expected

  return { stage: stageOf(delta), delta, expected, actual, etaMs, lastsToReset }
}

// A pace shows while quota is left (CodexBar also waits for 3% of the window; here every window shows one).
function shownPace(limit: Limit, minutes: number, now: number): Pace | null {
  if (limit.percentUsed >= 100) {
    return null
  }

  const pace = paceOf(limit, minutes, now)
  if (pace === null) {
    return null
  }

  return pace
}

function stageOf(delta: number): Stage {
  const size = Math.abs(delta)
  if (size <= 2) {
    return 'onTrack'
  }
  if (size <= 6) {
    return delta >= 0 ? 'slightlyAhead' : 'slightlyBehind'
  }
  if (size <= 12) {
    return delta >= 0 ? 'ahead' : 'behind'
  }

  return delta >= 0 ? 'farAhead' : 'farBehind'
}

type Gauge = {
  /** How much of the circle is drawn, 0 to 1, clockwise from twelve o'clock. */
  fraction: number
  color: string
}

// A ring in CodexBar's colours: a 22% grey track and the arc over it.
function ringSvg(gauge: Gauge): string {
  const size = RING_PX
  const center = size / 2
  const radius = (size - RING_STROKE) / 2 - 0.5
  const circumference = 2 * Math.PI * radius
  const arc = circumference * clamp(gauge.fraction, 0, 1)
  const circle = (attrs: string) =>
    `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${RING_STROKE}" ${attrs}/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    circle('stroke="#8E8E93" stroke-opacity="0.22"') +
    (arc > 0
      ? circle(
          `stroke="${gauge.color}" stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${center} ${center})"`,
        )
      : '') +
    `</svg>`
  )
}

// CodexBar's compact pace: + is quota spent ahead of an even pace, − is quota in reserve.
function paceText(delta: number): string {
  const size = Math.round(Math.abs(delta))

  return size === 0 ? '0%' : `${delta > 0 ? '+' : '−'}${size}%`
}

// Empty and full only when exactly so; anything between shows at least a quarter, at most three.
function glyphOf(fraction: number): string {
  const index = fraction <= 0 ? 0 : fraction >= 1 ? 4 : clamp(Math.round(fraction * 4), 1, 3)

  return GLYPHS[index] ?? GLYPHS[0]
}

function tokensText(tokens: number): string {
  const thousands = Math.round(tokens / 100) / 10
  if (thousands >= 1000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`
  }

  // Three digits are enough once past 100K: 239K, 42.5K.
  return thousands >= 100 ? `${Math.round(thousands)}K` : `${thousands.toFixed(1)}K`
}

// UsageFormatter.resetCountdownDescription, without its "in ".
function countdown(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : minutes > 0 ? `${days}d ${minutes}m` : `${days}d`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  return `${totalMinutes}m`
}

// A kitchen timer in minutes and seconds (the longest lifetime is an hour, 60:00), rounded up
// so it reads 0:01 until the last second goes.
function timerText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Active time as the desktop's usage panel prints it: 42s, 17m 6s, 1h 4m.
function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

// The engine's formatCost, as /usage prints the session total (cache reads and writes priced in):
// cents above half a dollar, four places below it.
function usdText(usd: number): string {
  return usd > 0.5 ? `$${(Math.round(usd * 100) / 100).toFixed(2)}` : `$${usd.toFixed(4)}`
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
