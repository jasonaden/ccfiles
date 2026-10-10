import { describe, expect, test } from 'claude-code/testing'
import { calibratedTokens, fitCalibration, readSamples, type Sample } from '../src/calibration.ts'
import { makeEvent, type LogRecord } from '../src/model.ts'
import { estTokens } from '../src/tokens.ts'
import { MEASURED } from './calibration-data.ts'
import { CWD, endSession, harness, readResult, startSession, tools } from './harness.ts'

const SESSIONS = ['opus-run1', 'opus-run2', 'sonnet']
const sessionSamples = (s: string): Sample[] => MEASURED.filter((m) => m.session === s).map(({ chars, real }) => ({ chars, real }))
const absErr = (est: number, real: number) => Math.abs(est / real - 1)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

describe('local calibration fit, on measured jupyterlab reads', () => {
  test('chars ÷ 4 misses every measured read by more than 25%', () => {
    for (const m of MEASURED) expect(absErr(estTokens('x'.repeat(m.chars)), m.real)).toBeGreaterThan(0.25)
  })

  test('learns a per-call overhead and a content ratio from one session', () => {
    for (const s of SESSIONS) {
      const cal = fitCalibration(sessionSamples(s))!
      expect(cal.samples).toBe(sessionSamples(s).length)
      expect(cal.overhead).toBeGreaterThan(10)
      expect(cal.overhead).toBeLessThan(40)
      expect(cal.ratio).toBeGreaterThan(0.38)
      expect(cal.ratio).toBeLessThan(0.42)
    }
  })

  test('a read the fit never saw is predicted far closer than chars ÷ 4 (leave one out)', () => {
    for (const s of SESSIONS) {
      const all = sessionSamples(s)
      const errs = all.map((x, i) => absErr(calibratedTokens(fitCalibration(all.filter((_, j) => j !== i)), x.chars), x.real))
      const raw = all.map((x) => absErr(estTokens('x'.repeat(x.chars)), x.real))
      expect(median(errs)).toBeLessThan(0.1)
      expect(median(raw)).toBeGreaterThan(0.35)
      expect(errs.filter((e) => e <= 0.25).length / errs.length).toBeGreaterThanOrEqual(0.95)
    }
  })

  test('the session total lands within 5% of real usage', () => {
    for (const s of SESSIONS) {
      const all = sessionSamples(s)
      const cal = fitCalibration(all)
      const est = all.reduce((n, x) => n + calibratedTokens(cal, x.chars), 0)
      const real = all.reduce((n, x) => n + x.real, 0)
      expect(absErr(est, real)).toBeLessThan(0.05)
    }
  })

  test('no samples: no calibration, numbers stay chars ÷ 4', () => {
    expect(fitCalibration([])).toBeNull()
    expect(calibratedTokens(null, 1001)).toBe(estTokens('x'.repeat(1001)))
  })

  test('one or two samples: a content ratio only, no overhead', () => {
    const cal = fitCalibration([{ chars: 4000, real: 1600 }])!
    expect(cal.overhead).toBe(0)
    expect(Math.abs(cal.ratio - 0.4)).toBeLessThan(1e-9)
    expect(calibratedTokens(cal, 2000)).toBe(800)
  })

  test('the overhead never goes negative', () => {
    // Real cost grows faster than linearly here, so a straight line would cross below zero.
    const cal = fitCalibration([
      { chars: 100, real: 10 },
      { chars: 1000, real: 300 },
      { chars: 10_000, real: 4000 },
    ])!
    expect(cal.overhead).toBe(0)
    expect(cal.ratio).toBeGreaterThan(0)
  })
})

// What the viewer logs per request: a `step` marker when it starts, its turn.step usage when it ends.
const P = { input_tokens: 2, cache_read_input_tokens: 0, output_tokens: 80 }
const step = (agentId: string | null = null): LogRecord => ({ t: 'step', ts: 0, agentId })
const usage = (context: number, extra: Partial<Extract<LogRecord, { t: 'usage' }>> = {}): LogRecord => ({
  t: 'usage',
  ts: 0,
  agentId: null,
  model: 'claude-opus-5-5',
  usage: { ...P, cache_creation_input_tokens: context - P.input_tokens },
  ...extra,
})
const read = (path: string, est: number, extra: Partial<Parameters<typeof makeEvent>[0]> = {}): LogRecord => ({
  t: 'event',
  e: makeEvent({ ts: 0, kind: 'read', tool: 'Read', path, source: 'tool', ranges: [[1, 10]], estTokens: est, ...extra }),
})

describe('samples from the session log (U-10 attribution)', () => {
  test('a request that asked for one Read: the next request grew by the read plus nothing else', () => {
    const samples = readSamples([step(), usage(10_000, { tools: 1 }), read('/r/a.ts', 1000), step(), usage(11_680)])
    // 11,680 − 10,000 − 80 output tokens of the request that asked for it.
    expect(samples).toEqual([{ chars: 4000, real: 1600 }])
  })

  test('tools that start while the reply streams: each read belongs to the request that asked for it', () => {
    const samples = readSamples([
      step(), read('/r/a.ts', 1000), usage(10_000, { tools: 1 }),
      step(), read('/r/b.ts', 500), usage(11_680, { tools: 1 }),
      step(), usage(12_660),
    ])
    expect(samples).toEqual([{ chars: 4000, real: 1600 }, { chars: 2000, real: 900 }])
  })

  test('a request with several tool calls gives no sample', () => {
    const samples = readSamples([step(), usage(10_000, { tools: 2 }), read('/r/a.ts', 1000), read('/r/b.ts', 500), step(), usage(12_000)])
    expect(samples).toEqual([])
  })

  test('a Read alongside a tool that leaves no event (a todo list) gives no sample', () => {
    expect(readSamples([step(), usage(10_000, { tools: 2 }), read('/r/a.ts', 1000), step(), usage(11_900)])).toEqual([])
  })

  test('a tool that leaves no read event (an MCP tool, a todo list) gives no sample', () => {
    expect(readSamples([step(), usage(10_000, { tools: 1 }), step(), usage(10_500)])).toEqual([])
  })

  test('a subagent pairs with its own requests; the main agent in between changes nothing', () => {
    const sub = { agentId: 'a1' }
    const samples = readSamples([
      step('a1'), usage(5000, { ...sub, tools: 1 }),
      step(), usage(40_000, { tools: 0 }),
      read('/r/a.ts', 1000, sub),
      step(), usage(41_000, { tools: 0 }),
      step('a1'), usage(6680, sub),
    ])
    expect(samples).toEqual([{ chars: 4000, real: 1600 }])
  })

  test('a nested instruction load attached to the next request spoils the sample', () => {
    const samples = readSamples([
      step(), usage(10_000, { tools: 1 }), read('/r/sub/a.ts', 1000),
      step(),
      { t: 'event', e: makeEvent({ ts: 0, kind: 'autoload', path: '/r/sub/CLAUDE.md', source: 'attachment', estTokens: 300, loadReason: 'nested_memory' }) },
      usage(12_000),
    ])
    expect(samples).toEqual([])
  })

  test("what was attached to the request that asked for the read is already in its context: no reason to skip", () => {
    const samples = readSamples([
      step(),
      { t: 'injected', ts: 0, type: 'instructions', estTokens: 834, agentId: null },
      { t: 'event', e: makeEvent({ ts: 0, kind: 'autoload', path: '/r/AGENTS.md', source: 'promptContext', estTokens: 762 }) },
      usage(10_000, { tools: 1 }), read('/r/a.ts', 1000),
      step(), usage(11_680),
    ])
    expect(samples).toEqual([{ chars: 4000, real: 1600 }])
  })

  test('small reminders Claude Code adds to every request are part of the overhead, not a reason to skip', () => {
    const samples = readSamples([
      step(), usage(10_000, { tools: 1 }), read('/r/a.ts', 1000),
      step(), { t: 'injected', ts: 0, type: 'total_tokens_reminder', estTokens: 20, agentId: null }, usage(11_700),
    ])
    expect(samples).toEqual([{ chars: 4000, real: 1620 }])
  })

  test('a large attachment on the next request spoils the sample', () => {
    const samples = readSamples([
      step(), usage(10_000, { tools: 1 }), read('/r/a.ts', 1000),
      step(), { t: 'injected', ts: 0, type: 'diagnostics', estTokens: 400, agentId: null }, usage(12_400),
    ])
    expect(samples).toEqual([])
  })

  test('a compaction between the two requests gives no sample', () => {
    expect(readSamples([step(), usage(90_000, { tools: 1 }), read('/r/a.ts', 1000), step(), usage(20_000)])).toEqual([])
  })

  test('a failed read, or a log written before the viewer kept step markers, gives no sample', () => {
    expect(readSamples([step(), usage(10_000, { tools: 1 }), read('/r/a.ts', 50, { outcome: 'error' }), step(), usage(10_200)])).toEqual([])
    expect(readSamples([usage(10_000, { tools: 1 }), read('/r/a.ts', 1000), usage(11_680)])).toEqual([])
  })
})

describe('the viewer logs what calibration needs (turn.step)', () => {
  test('a step marker when a request starts and the tool count with its usage; the first measured read pairs exactly', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    const ghost = `${CWD}/ghost.ts`
    // opus-run1's first two requests: Read ghost.ts (21,700 chars received), then the next request.
    const steps = [
      { usage: { input_tokens: 2, output_tokens: 76, cache_read_input_tokens: 1556, cache_creation_input_tokens: 6119, model: 'claude-opus-5-5' }, toolUses: [{ name: 'Read', input: { file_path: ghost } }] },
      { usage: { input_tokens: 2, output_tokens: 74, cache_read_input_tokens: 7675, cache_creation_input_tokens: 8925, model: 'claude-opus-5-5' }, toolUses: [] },
    ]
    on('turn.step', async function* (_$, e) {
      const s = steps[e.index]!
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: s.toolUses, stopReason: 'tool_use', usage: s.usage } as never
    })
    const runStep = async (index: number) => {
      const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 })
      for await (const _ of stream) void _
      await stream.result
    }
    await startSession($)
    await runStep(0)
    await t.call($, { tool: 'Read', file_path: ghost }, { ...readResult(ghost, 'x\n'.repeat(638)), text: 'x'.repeat(21_700) })
    await runStep(1)
    await endSession($)
    const recs = h.records()
    expect(recs.filter((r) => r.t === 'step')).toHaveLength(2)
    expect(recs.filter((r) => r.t === 'usage').map((r) => (r as { tools?: number }).tools)).toEqual([1, 0])
    expect(readSamples(recs)).toEqual([{ chars: 21_700, real: 8849 }])
  })
})
