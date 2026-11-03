import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

// 2026-10-05 19:00 UTC.
const NOW = Date.UTC(2026, 9, 5, 19, 0, 0)
const MIN = 60_000

const BAND = {
  plugin: 'frontier-pacer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const LIMITS = [
  // Half the 5h window gone, 62% used: 12 points ahead of pace, empty in about 92 minutes.
  { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(NOW + 150 * MIN).toISOString() },
  // Half the week gone, 44% used: 6 points in reserve, lasts until reset.
  { kind: 'seven_day', percentUsed: 44, resetsAt: new Date(NOW + 5040 * MIN).toISOString() },
]

// What the account usage endpoint (/usage's source) answers: the session at 62.7%, so /usage reads 62%.
const USAGE_BODY = {
  five_hour: { utilization: 62.7, resets_at: LIMITS[0]?.resetsAt },
  seven_day: { utilization: 44, resets_at: LIMITS[1]?.resetsAt },
  seven_day_sonnet: null,
  limits: [
    { kind: 'weekly_scoped', percent: 3, resets_at: LIMITS[1]?.resetsAt, scope: { model: { display_name: 'Fable' } } },
  ],
}

function response(at: number, split: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number }): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 2_510, cache_creation: split },
    },
  })
}

// What the engine's ledger holds; a test moves it to show the band reads it again.
const ledger = { usd: 4.2137 }

function ran(stdout: string): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// The engine beneath the mod: usage, the session id, and the host commands it runs.
function host(on: On, transcript: { text: string; rows?: string }, usage: { body: unknown } = { body: USAGE_BODY }, model = 'claude-fable-5-1', stored: Record<string, unknown> = {}, env: Record<string, string> = {}, session = { id: 'sess-1' }): void {
  ledger.usd = 4.2137
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  // The plugin's store, kept in `stored` itself so a test reads what the other sessions would.
  on('store.get', (_$, e) => ({ value: stored[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(stored[e.key])) }))
  on('store.set', (_$, e) => {
    stored[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete stored[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(stored) }))
  on('ui.render', () => ({ type: 'Box' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.id', () => ({ value: session.id }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Summary of the work so far.', toolUses: [] }], tokensBefore: 900_000, tokensAfter: 40_000, usage: { input_tokens: 2, output_tokens: 4_000, cache_read_input_tokens: 880_000, cache_creation_input_tokens: 0 } }))
  on('session.model', () => ({ value: model }))
  on('session.version', () => ({ value: { version: '2.1.293', base: '2.1.293' } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.authorize', () => ({ value: { handle: 'h-1', kind: 'bearer' } }))
  on('http.fetch', (_$, e) => {
    if (usage.body === 'limited') {
      return { value: { status: 429, ok: false, headers: { 'retry-after': '600' } as Record<string, string>, text: '' } }
    }
    // The endpoint answers only Claude Code's User-Agent; anything else gets an hour's 429.
    if (e.init?.headers?.['user-agent'] !== 'claude-code/2.1.293') {
      return { value: { status: 429, ok: false, headers: { 'retry-after': '3600' } as Record<string, string>, text: '' } }
    }
    if (e.url !== 'https://api.anthropic.com/api/oauth/usage' || usage.body === null) {
      return { value: { status: 503, ok: false, headers: {}, text: '' } }
    }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(usage.body) } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 142_512, window: 1_000_000, percent: 14 },
      rateLimits: LIMITS,
      cost: { usd: ledger.usd },
    },
  }))
  on('process.run', (_$, e) => {
    const [command] = e.argv
    if (command === 'awk') {
      // `timeout` stands for awk killed at its time limit.
      return { value: transcript.rows === 'timeout' ? { ...ran(''), exitCode: 143 } : ran(transcript.rows ?? '') }
    }
    if (command === '/bin/sh') {
      return { value: ran('/Users/x/.claude/projects/-tmp/sess-1.jsonl\n') }
    }

    return { value: ran(transcript.text) }
  })
}

async function start($: Engine, clock: ReturnType<typeof mock.clock>): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  await clock.settle()
}

async function step($: Engine, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId })
  for await (const _ of stream) {
    // drain
  }
}

async function texts(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node)
    } else if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      const element = node as { type?: string; props?: { source?: string }; children?: unknown }
      if (element.type === 'Svg') {
        out.push(element.props?.source?.includes('<circle') === true ? '[ring]' : '[svg]')
      }
      walk(element.children)
    }
  }
  walk(await ui.drawn())

  return out
}

test('draws nothing of its own before the first figure', async ($, on) => {
  host(on, { text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'ctx' })).toBeUndefined()
})

test('exact context, the cache timer, the cost and both pace rings, on the terminal', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')

  expect(line).toContain('ctx 143K $4.21 active')
  expect(line).not.toContain('1M')
  // Seeded from the transcript: answered ten minutes ago with a 1h write, so 50 minutes left.
  expect(line).toContain('cache ◕ 50:00')
  // /usage's 62.7% reads 62% used, 12.7 points past an even pace of 50%: +13%, in red.
  expect(line).toContain('5h ◑ 62% +13% empty in 1h 30m')
  // 44% used against a 50% pace: 6 points in reserve, in green, and it lasts to the reset.
  expect(line).toContain('7d ◑ 44% −6%')
  // The week scoped to one model, as /usage lists it.
  expect(line).toContain('7d Fable ◔ 3% −47%')
  expect(line).not.toContain('pace')
  expect(line).not.toContain('out in')

  expect((await ui.find({ type: 'Text', text: '+13%' }))?.props.color).toBe('#FF3B30')
  expect((await ui.find({ type: 'Text', text: '−6%' }))?.props.color).toBe('#34C759')
})

test('the same figures on the desktop, with rings drawn as SVG', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = (await texts(ui)).join(' ')

  expect(line).toContain('5h [ring] 62% +13%')
  expect(line).toContain('7d [ring] 44% −6%')
  expect(line).toContain('cache [ring] 50:00')
})

test('a main-thread request restarts the hour; the countdown reddens, then expires', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ● 60:00')

  await clock.advance(55 * MIN)
  await ui.redraw()
  const late = await ui.find({ type: 'Text', text: '5:00' })
  expect(late?.props.color).toBe('#FF3B30')
  expect((await texts(ui)).join(' ')).toContain('cache ◔ 5:00')

  await clock.advance(6 * MIN)
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('cache ○ expired')
})

test('a subagent request leaves the main cache alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)
  await clock.advance(5 * MIN)
  await step($, 'agent-7')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ◕ 45:00')
})

test('a five-minute write in the transcript sets a five-minute lifetime', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const transcript = { text: '' }
  host(on, transcript)
  await start($, clock)
  await step($)
  transcript.text = `{"type":"user"}\n${response(NOW, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2_510 })}\n`
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ● 5:00')
})

test('/clear forgets the cache and the context figure', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)
  await $.session.end({ reason: 'clear' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('$4.21 active 0s')
})

test('the cost follows the engine ledger as it grows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' })
  await start($, clock)
  await $.session.measure({
    context: { tokens: 150_000, window: 1_000_000, percent: 15 },
    rateLimits: LIMITS,
    cost: { usd: 5.5 },
    changed: ['cost', 'context'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')
  expect(line).toContain('ctx 150K')
  expect(line).toContain('$5.50')
})

test('without the usage endpoint the band falls back to the response headers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' }, { body: null })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')
  expect(line).toContain('5h ◑ 62% +12%')
  expect(line).not.toContain('Fable')
})

test('a week scoped to another model stays hidden', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' }, { body: USAGE_BODY }, 'claude-opus-5-5')
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')
  expect(line).toContain('7d ◑ 44%')
  expect(line).not.toContain('Fable')
})

test('a session under half a dollar reads to four places, as /usage prints it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' })
  await start($, clock)
  await $.session.measure({
    context: { tokens: 58_500, window: 200_000, percent: 29 },
    rateLimits: LIMITS,
    cost: { usd: 0.11753 },
    changed: ['cost'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('$0.1175')
})

test('active is the time the model worked: past turns from the transcript, then the live one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()
  // Three turns run by earlier processes (the app paused the session in between): 50 minutes with a
  // tool running most of it, 10 minutes, and 7 minutes 6 seconds. All count; the days between do not.
  const rows = [
    `U ${at(-3000)}`, `T ${at(-2999)}`, `W ${at(-2951)}`, `E ${at(-2950)}`,
    `U ${at(-80)}`, `T ${at(-79)}`, `W ${at(-78)}`, `E ${at(-70)}`,
    `U ${at(-60)}`, `W ${at(-59.5)}`, `E ${at(-52.9)}`,
  ].join('\n')
  const stored: Record<string, unknown> = {}
  host(on, { text: '', rows: `${rows}\n` }, { body: USAGE_BODY }, 'claude-fable-5-1', stored)
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 1h 7m')
  // The first read is kept for every later process of the session.
  expect((stored['active:sess-1'] as { ms: number }).ms).toBe(4_026_000)

  // Idle time adds nothing, whatever the surface says of work.
  await clock.advance(30 * MIN)
  const idle = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
  expect((await texts(idle)).join(' ')).toContain('active 1h 7m')

  // A new turn counts live while it runs.
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(54_000)
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('active 1h 8m')

  // At its end the engine's own length of it is added, and stored.
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 54_000, isAborted: false, turnId: 't1' })
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('active 1h 8m')
  expect((stored['active:sess-1'] as { ms: number }).ms).toBe(4_026_000 + 54_000)
})

test('active never counts a pause the transcript left open as work', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()
  // A turn cut short (no ending recorded), then four days later an event that started a turn without
  // a prompt: 5 minutes, then 3 minutes, not four days.
  const rows = [`U ${at(-6000)}`, `T ${at(-5999)}`, `W ${at(-5995)}`, `W ${at(-240)}`, `T ${at(-239)}`, `E ${at(-237)}`].join('\n')
  host(on, { text: '', rows: `${rows}\n` })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 8m 0s')
})

test('a session the store already counts is not read from the transcript again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()
  // The transcript would say 10 minutes; the store, kept turn by turn, says 3 hours.
  const stored: Record<string, unknown> = { 'active:sess-1': { ms: 180 * MIN, at: NOW - MIN } }
  host(on, { text: '', rows: `U ${at(-20)}\nE ${at(-10)}\n` }, { body: USAGE_BODY }, 'claude-fable-5-1', stored)
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 3h 0m')
})

test('loaded mid-turn, the running turn is never counted twice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()
  // Ten minutes done, and a turn whose transcript reaches a minute in when the mod loads.
  host(on, { text: '', rows: `U ${at(-30)}\nE ${at(-20)}\nU ${at(-2)}\nT ${at(-1)}\n` })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 11m 0s')

  // It ends a minute after the load, three minutes long by the engine's count: the transcript held
  // its first minute, so only the minute since the load is added.
  await clock.advance(MIN)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 3 * MIN, isAborted: false, turnId: 't0' })
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('active 12m 0s')
})

test('a turn cut short just before the session was taken up again does not tick while idle', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const at = (minutes: number) => new Date(NOW + minutes * MIN).toISOString()
  // Interrupted two minutes ago, ten minutes in: the interruption is the last row, and nothing runs now.
  host(on, { text: '', rows: `U ${at(-12)}\nT ${at(-11)}\nW ${at(-3)}\nU ${at(-2)}\n` })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 10m 0s')
  await clock.advance(20 * MIN)
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('active 10m 0s')
})

test('a subagent turn neither starts nor stops the main clock', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '', rows: '' })
  await start($, clock)
  await $.turn.start({ text: 'research', turnId: 'a1', agentId: 'agent-7' } as never)
  await clock.advance(5 * MIN)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 0s')
})

test('/resume reads the other session\'s own time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = { id: 'sess-1' }
  const stored: Record<string, unknown> = { 'active:sess-1': { ms: 5 * MIN, at: NOW }, 'active:sess-2': { ms: 2 * 60 * MIN, at: NOW } }
  host(on, { text: '', rows: '' }, { body: USAGE_BODY }, 'claude-fable-5-1', stored, {}, session)
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('active 5m 0s')

  session.id = 'sess-2'
  await $.session.end({ reason: 'resume' } as never)
  await clock.advance(1)
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('active 2h 0m')
})

test('the week shows its pace from the first hour', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Two hours into the week with 2% used: an even pace is at 1.2%, so +1%.
  const weekStart = NOW - 2 * 60 * MIN
  host(on, { text: '' }, {
    body: {
      five_hour: { utilization: 16, resets_at: new Date(NOW + 200 * MIN).toISOString() },
      seven_day: { utilization: 2, resets_at: new Date(weekStart + 10_080 * MIN).toISOString() },
      limits: [],
    },
  })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('7d ◔ 2% +1%')
  expect((await texts(ui)).join(' ')).not.toContain('out in')
})

test('the cache timer counts from the last request even while Claude works', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)

  // A tool has run for ten minutes since the last request: the cache has aged ten minutes.
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ◕ 50:00')
  // The working flag going on and off does not move it.
  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(idle)).join(' ')).toContain('cache ◕ 50:00')
})

test('a compaction\'s own request restarts the lifetime', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` }, { body: USAGE_BODY }, 'claude-opus-5-5', {}, { CLAUDE_CODE_USE_FOUNDRY: '1' })
  await start($, clock)
  await clock.advance(20 * MIN)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ◑ 30:00')

  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'go', toolUses: [] }] } as never)
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('cache ● 60:00')

  // A subagent compacting its own transcript leaves the main cache alone.
  await clock.advance(5 * MIN)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'go', toolUses: [] }], agentId: 'agent-7' } as never)
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('cache ◕ 55:00')
})

test('the cost follows the ledger between measurements', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' })
  await start($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('$4.21')

  // The engine settles a cost with no measurement (a compaction's request, a restored session).
  ledger.usd = 98.51
  await clock.advance(5_000)
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('$98.51')
})

test('the endpoint is read again each minute, and outranks the headers of a response while fresh', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const usage = { body: USAGE_BODY as unknown }
  host(on, { text: '' }, usage)
  await start($, clock)

  usage.body = { ...USAGE_BODY, five_hour: { utilization: 70.4, resets_at: LIMITS[0]?.resetsAt } }
  await clock.advance(61_000)
  await clock.settle()
  // A response whose headers still say 62% lands a moment later.
  await $.session.measure({
    context: { tokens: 150_000, window: 1_000_000, percent: 15 },
    rateLimits: LIMITS,
    cost: { usd: 4.5 },
    changed: ['cost'],
  })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('5h ◕ 70%')
})

test('the endpoint is asked as Claude Code, which it requires', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The host answers 429 to any other User-Agent; only the endpoint knows the Fable week.
  const store: Record<string, unknown> = {}
  host(on, { text: '' }, { body: USAGE_BODY }, 'claude-fable-5-1', store)
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('7d Fable ◔ 3%')
  expect((store.readings as { retryAt?: number }).retryAt).toBeUndefined()
})

test('one line: the least needed figures give way when the line is short', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` })
  await start($, clock)

  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'terminal' })
  const line = (await texts(narrow)).join(' ')
  expect(line).toContain('5h ◑ 62% +13%')
  expect(line).toContain('7d ◑ 44% −6%')
  expect(line).toContain('cache ◕ 50:00')
  expect(line).not.toContain('empty in')
  expect(line).not.toContain('active')
  expect(line).not.toContain('$4.21')
})

test('/pace hides the band and brings it back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' })
  await start($, clock)

  const off = await $.command.run({ command: 'pace', args: '' } as never)
  expect(off.text).toContain('hidden')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).not.toContain('5h')

  await $.command.run({ command: 'pace', args: 'on' } as never)
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('5h')
})

test('a response newer than the last endpoint reading shows its own figures', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The endpoint has refused for an hour and a half; the stored reading is from before that.
  const old = NOW - 100 * MIN
  const store: Record<string, unknown> = {
    readings: {
      readings: [
        { kind: 'five_hour', percentUsed: 35, resetsAt: LIMITS[0]?.resetsAt ?? null, at: old },
        { kind: 'weekly:Fable', percentUsed: 3, resetsAt: LIMITS[1]?.resetsAt ?? null, at: old },
      ],
      retryAt: NOW + 10 * MIN,
    },
  }
  host(on, { text: '' }, { body: 'limited' }, 'claude-fable-5-1', store)
  await start($, clock)
  await $.session.measure({
    context: { tokens: 150_000, window: 1_000_000, percent: 15 },
    rateLimits: LIMITS,
    cost: { usd: 4.5 },
    changed: ['cost'],
  })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')
  expect(line).toContain('5h ◑ 62%')
  expect(line).toContain('7d ◑ 44%')
  // Only the endpoint knows the week scoped to one model, so its last reading stays.
  expect(line).toContain('7d Fable ◔ 3%')
  // And the other sessions see it too.
  const stored = store.readings as { readings: Array<{ kind: string; percentUsed: number }> }
  expect(stored.readings.find(r => r.kind === 'five_hour')?.percentUsed).toBe(62)
})

test('a 429 holds every session back as long as the endpoint asks, and longer each time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const usage = { body: 'limited' as unknown }
  const store: Record<string, unknown> = {}
  host(on, { text: '' }, usage, 'claude-fable-5-1', store)
  await start($, clock)

  const first = store.readings as { retryAt: number; strikes: number }
  // Retry-After said 10 minutes, more than the first 5-minute backoff.
  expect(first.retryAt).toBe(NOW + 1 + 10 * MIN)
  expect(first.strikes).toBe(1)

  await clock.advance(11 * MIN)
  await clock.settle()
  const second = store.readings as { retryAt: number; strikes: number }
  expect(second.strikes).toBe(2)
  expect(second.retryAt).toBeGreaterThan(NOW + 11 * MIN + 9 * MIN)

  // Once it answers, the wait is forgotten.
  usage.body = USAGE_BODY
  await clock.advance(30 * MIN)
  await clock.settle()
  const after = store.readings as { retryAt?: number; strikes?: number }
  expect(after.retryAt).toBeUndefined()
  expect(after.strikes).toBeUndefined()
})

test('a window past its reset reads as unused', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' }, { body: null }, 'claude-fable-5-1', {
    readings: { readings: [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(NOW - MIN).toISOString(), at: NOW - 10 * MIN }] },
  })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = (await texts(ui)).join(' ')
  expect(line).toContain('5h ○ 0%')
  expect(line).not.toContain('90%')
})

test('every session shows the newest reading any of them fetched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Another session fetched 81% a moment ago; this one's endpoint is down.
  host(on, { text: '' }, { body: null }, 'claude-fable-5-1', {
    readings: { readings: [{ kind: 'five_hour', percentUsed: 81, resetsAt: LIMITS[0]?.resetsAt ?? null, at: NOW - 2_000 }] },
  })
  await start($, clock)
  await clock.advance(5_000)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('5h ◕ 81%')
})

test('on Vertex the band keeps context, cost and cache but draws no plan windows and asks no endpoint', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // A reading another session shared from the subscription days must not show either.
  const stored: Record<string, unknown> = {
    readings: { readings: [{ kind: 'five_hour', percentUsed: 81, resetsAt: LIMITS[0]?.resetsAt ?? null, at: NOW - 2_000 }] },
  }
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n` }, { body: USAGE_BODY }, 'claude-opus-5-5', stored, { CLAUDE_CODE_USE_VERTEX: '1' })
  await start($, clock)
  await clock.advance(2 * MIN)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = (await texts(ui)).join(' ')

  expect(line).toContain('ctx 143K $4.21 active')
  expect(line).toContain('cache [ring]')
  expect(line).not.toContain('5h')
  expect(line).not.toContain('7d')
  // The endpoint was never asked: asking claims a turn in the shared store first.
  expect((stored.readings as { askedAt?: number }).askedAt).toBeUndefined()
})

test('before any response says, the cache timer waits rather than guess the lifetime', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' }, { body: USAGE_BODY }, 'claude-opus-5-5', {}, { CLAUDE_CODE_USE_FOUNDRY: '1' })
  await start($, clock)
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).not.toContain('cache')
})

test('a lifetime the transcript records just after the turn ends is picked up within seconds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const transcript = { text: '' }
  host(on, transcript, { body: USAGE_BODY }, 'claude-opus-5-5', {}, { CLAUDE_CODE_USE_FOUNDRY: '1' })
  await start($, clock)
  await step($)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1' })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).not.toContain('cache')

  transcript.text = `${response(NOW, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n`
  await clock.advance(5_000)
  await clock.settle()
  await ui.redraw()
  expect((await texts(ui)).join(' ')).toContain('cache ◕ 59:55')
})

test('a transcript that cannot be read whole is not stored as the session\'s time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const stored: Record<string, unknown> = {}
  // awk ran past its time: the history is unknown, so the next process reads it again.
  host(on, { text: '', rows: 'timeout' }, { body: USAGE_BODY }, 'claude-fable-5-1', stored)
  await start($, clock)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1' })
  await clock.settle()

  expect(stored['active:sess-1']).toBeUndefined()
})

test('an environment variable that pins the lifetime is used before any response says', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  host(on, { text: '' }, { body: USAGE_BODY }, 'claude-opus-5-5', {}, { CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await start($, clock)
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await texts(ui)).join(' ')).toContain('cache ● 60:00')
})

test('a response that only read the cache keeps the lifetime of the last one that wrote it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const readOnly = JSON.stringify({
    type: 'assistant', isSidechain: false, timestamp: new Date(NOW - 2 * MIN).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } },
  })
  host(on, { text: `${response(NOW - 10 * MIN, { ephemeral_1h_input_tokens: 2_510, ephemeral_5m_input_tokens: 0 })}\n${readOnly}\n` }, { body: USAGE_BODY }, 'claude-opus-5-5', {}, { CLAUDE_CODE_USE_VERTEX: '1' })
  await start($, clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Read two minutes ago, an hour's lifetime: 58 minutes left.
  expect((await texts(ui)).join(' ')).toContain('58:00')
})
