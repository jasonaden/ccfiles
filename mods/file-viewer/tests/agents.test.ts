// Subagents. The agent registry, attribution by `tool.call` `e.agentId`, per-agent coverage and ≈ tokens, the
// viewpoint switch, per-agent instruction loads and per-agent exact usage.
import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import { agentTable, agentState, MAIN } from '../src/agents.ts'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { MIN_TAG_MS, treeRows, type ViewContext } from '../src/view/rows.ts'
import { windowLines } from '../src/view/draw.ts'
import { fileBadge } from '../src/view/agentsline.ts'
import { defaultPalette } from '../src/palette.ts'
import { cellWidth } from '../src/view/text.ts'
import { unmarkedTokenFigures } from '../src/tokens.ts'
import { agentLines, detailLines, helpView } from '../src/view/detail.ts'
import { serializeLog } from '../src/log.ts'
import { BIG, CWD, LOG, SMALL, harness, readResult, startSession, endSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clientLines, lineText } from './rows-client.ts'

const BIG_PATH = `${CWD}/big.md`
const SMALL_PATH = `${CWD}/small.ts`
const EXPLORE = 'a0ccdd61e74e15cd4'
const EXPLORE2 = 'a7a8b5e384d608047'

/** An Explore subagent started the way 2.1.295 reports it: SubagentStart, then agent.spawn's answer. */
async function spawn($: Engine, on: On, id: string, type = 'Explore', parent?: string) {
  await $.classic.SubagentStart({ agent_id: id, agent_type: type } as never)
  await $.agent.spawn({ tool_use_id: `toolu_spawn_${id}`, prompt: 'read', description: `task ${id}`, subagentType: type, ...(parent ? { parentAgentId: parent } : {}) } as never)
}

/** Answers agent.spawn in Claude Code's place with the id the test chose. */
function spawner(on: On) {
  on('agent.spawn', (_$, e) => ({ model: 'm', agentId: (e as { description: string }).description.slice('task '.length) }) as never)
}

const rowText = async (ui: Parameters<typeof clientLines>[0], path: string) => lineText((await clientLines(ui)).find((l) => l.id === `f:${path}`) ?? { id: '', segs: [] })

/**
 * Steps the viewpoint with `a` (a hidden hotkey) to `label`. No switcher row is drawn, so the steps are counted from
 * the default viewpoint, main: main → each subagent → main (no `all` mode).
 */
const viewpoints = new WeakMap<object, number>()
async function switchTo(ui: { press: (q: { key: string }) => Promise<unknown> }, label: string, modes: readonly string[] = ['main', 'Explore#1']) {
  const want = modes.indexOf(label)
  if (want < 0) throw new Error(`no viewpoint ${label}`)
  let at = viewpoints.get(ui) ?? 0
  while (at !== want) {
    await ui.press({ key: 'key:a' })
    at = (at + 1) % modes.length
  }
  viewpoints.set(ui, at)
}

describe('agent registry', () => {
  test('SubagentStart + agent.spawn + SubagentStop: type, label, parent, description, start, end and status; forks are left out', async ($, on) => {
    const h = harness(on)
    on('agent.spawn', (_$, e) => ({ model: 'm', agentId: (e as { parentAgentId?: string }).parentAgentId ? EXPLORE2 : EXPLORE }) as never)
    await startSession($)
    await $.classic.SubagentStart({ agent_id: 'fork1', agent_type: '' } as never)
    await $.classic.SubagentStart({ agent_id: EXPLORE, agent_type: 'Explore' } as never)
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Read big.md lines 1-300', subagentType: 'Explore' } as never)
    await h.clock.advance(1000)
    await $.classic.SubagentStart({ agent_id: EXPLORE2, agent_type: 'Explore' } as never)
    await $.agent.spawn({ tool_use_id: 't2', prompt: 'p', description: 'nested', subagentType: 'Explore', parentAgentId: EXPLORE } as never)
    await h.clock.advance(2000)
    await $.classic.SubagentStop({ agent_id: EXPLORE, agent_type: 'Explore' } as never)
    await $.classic.SubagentStop({ agent_id: 'fork1', agent_type: '' } as never)
    await endSession($)
    const s = h.state()
    expect([...s.registry.keys()]).toEqual([EXPLORE, EXPLORE2])
    const a = s.registry.get(EXPLORE)!
    expect(a).toMatchObject({ id: EXPLORE, type: 'Explore', label: 'Explore#1', parentId: null, description: 'Read big.md lines 1-300', status: 'done' })
    expect(a.end! - a.start).toBe(3000)
    expect(s.registry.get(EXPLORE2)).toMatchObject({ label: 'Explore#2', parentId: EXPLORE, description: 'nested', status: 'running', end: null })
  })
})

describe('an Explore subagent and the main conversation', () => {
  async function run($: Engine, on: On) {
    const h = harness(on)
    const t = tools(on)
    spawner(on)
    host(on)
    await startSession($)
    await spawn($, on, EXPLORE)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 300, agentId: EXPLORE }, readResult(BIG_PATH, BIG, 1, 300))
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await h.clock.advance(MIN_TAG_MS)
    return h
  }

  test('two agents listed; big.md attributed to Explore only, small.ts to main only', async ($, on) => {
    const h = await run($, on)
    await endSession($)
    const s = h.state()
    expect(agentTable(s).rows.map((r) => r.label)).toEqual(['main', 'Explore#1'])
    const big = s.files.get(BIG_PATH)!
    expect([...big.byAgent.keys()]).toEqual([EXPLORE])
    expect(big.byAgent.get(EXPLORE)!.intervals).toEqual([[1, 300]])
    expect([...s.files.get(SMALL_PATH)!.byAgent.keys()]).toEqual([MAIN])
  })

  test('main view: big.md shows Explore’s `E` badge and `(≈N)`, with no meter of its own; small.ts shows as main read it', async ($, on) => {
    await run($, on)
    const ui = await $.ui.mount(pane(60, 16))
    await switchTo(ui, 'main')
    // Gutter cell 0 blank (main didn't read it), the `E` badge in cell 1, and the figure in parentheses; the right
    // column shows ≈ tokens, not `R/T`.
    expect(await rowText(ui, BIG_PATH)).toMatch(/^  E .*big\.md +\(≈\d[\d.]*k?\)$/)
    expect(await rowText(ui, SMALL_PATH)).toMatch(/^● {2}.*small\.ts +≈\d[\d.]*k?$/)
    // Explore's own view: big.md partly read (the meter), with its ≈ tokens; small.ts is main's (`m`).
    await switchTo(ui, 'Explore#1')
    expect(await rowText(ui, BIG_PATH)).toMatch(/^[◔◑◕] {2}.*big\.md +≈\d[\d.]*k?$/)
    expect(await rowText(ui, SMALL_PATH)).toMatch(/^  m .*small\.ts +\(≈\d[\d.]*k?\)$/)
  })

  // No switcher line is drawn; `a` steps the viewpoint, and only once a subagent exists.
  test('`a` switches the viewpoint only once a subagent exists; no switcher line is drawn', async ($, on) => {
    const h = harness(on)
    host(on)
    spawner(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(60, 16))
    const before = await screen(ui)
    await ui.press({ key: 'key:a' })
    expect(await screen(ui)).toEqual(before)
    await spawn($, on, EXPLORE)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 300, agentId: EXPLORE }, readResult(BIG_PATH, BIG, 1, 300))
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    // The default viewpoint is main: big.md is Explore's; `a` steps to Explore#1, where small.ts is main's.
    expect(await rowText(ui, BIG_PATH)).toMatch(/^  E .*big\.md +\(≈/)
    await ui.press({ key: 'key:a' })
    expect(await rowText(ui, BIG_PATH)).not.toMatch(/^ E|\(≈/)
    expect(await rowText(ui, SMALL_PATH)).toMatch(/^  m .*small\.ts +\(≈/)
    for (const l of await screen(ui)) expect(l).not.toMatch(/^a: |main · Explore#1/)
  })
})

describe('two subagents read overlapping ranges', () => {
  const T = 1_000_000
  const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 60_000, ...e }) })
  const records: LogRecord[] = [
    { t: 'agent', ts: 1, agentId: EXPLORE, agentType: 'Explore' },
    { t: 'agent', ts: 2, agentId: EXPLORE2, agentType: 'Explore' },
    ev({ kind: 'read', path: BIG_PATH, ranges: [[1, 300]], totalLines: 1323, estTokens: 3000, agentId: EXPLORE, agentType: 'Explore' }),
    ev({ kind: 'read', path: BIG_PATH, ranges: [[200, 500]], totalLines: 1323, estTokens: 3000, agentId: EXPLORE2, agentType: 'Explore' }),
    ev({ kind: 'read', path: SMALL_PATH, ranges: [[1, 40]], totalLines: 40, estTokens: 100 }),
  ]
  const ctx = (s = replay(records), extra: Partial<ViewContext> = {}): ViewContext => ({ state: s, root: CWD, home: null, projectFiles: [BIG_PATH, SMALL_PATH], git: null, pending: new Map(), now: T, ...extra })

  test('each agent keeps its own ranges; neither is a re-read for the other', () => {
    const big = replay(records).files.get(BIG_PATH)!
    expect(big.byAgent.get(EXPLORE)).toMatchObject({ intervals: [[1, 300]], reads: 1, rereads: 0, estTokens: 3000 })
    expect(big.byAgent.get(EXPLORE2)).toMatchObject({ intervals: [[200, 500]], reads: 1, rereads: 0, estTokens: 3000 })
    expect(big.intervals).toEqual([[1, 500]])
    expect(agentState(replay(records), EXPLORE2).files.get(BIG_PATH)!.intervals).toEqual([[200, 500]])
  })

  // No `all` mode; seen from main, both Explores show as one `E` badge
  // (one type), and the rows keep the anatomy at every width.
  test('main viewpoint: big.md carries one E badge for two Explores; small.ts has none', () => {
    const s = replay(records)
    expect(fileBadge(s.files.get(BIG_PATH)!, s, MAIN)).toBe('E')
    expect(fileBadge(s.files.get(SMALL_PATH)!, s, MAIN)).toBe(null)
    expect(fileBadge(s.files.get(BIG_PATH)!, s, EXPLORE)).toBe('E')
  })

  test('with badges, every row stays one line at 39, 60 and 100 columns', () => {
    const s = replay(records)
    const rows = treeRows(ctx(s), { expanded: new Set(), query: '', sort: 'recent' })
    const look = { glyphs: 'plain' as const, value: 'tokens' as const, now: T, badge: (p: string) => { const b = fileBadge(s.files.get(p)!, s, MAIN); return b ? { text: b, live: false } : null } }
    for (const width of [39, 60, 100]) {
      for (const theme of ['dark', 'light'] as const) {
        const lines = windowLines(rows, width, defaultPalette(theme), look, undefined).map((l) => l.segs.map((x) => x.t).join(''))
        for (const l of lines) expect(cellWidth(l)).toBe(width)
        const big = lines[rows.findIndex((r) => r.path === BIG_PATH)]!
        expect(big[2]).toBe('E')
      }
    }
  })


  test('the detail view lists each agent’s ranges', () => {
    const s = replay(records)
    const text = detailLines(s.files.get(BIG_PATH)!, { root: CWD, home: null, git: null, themeHint: null, session: s }).map((l) => l.map((c) => c.text).join(''))
    expect(text).toContainEqual(expect.stringMatching(/Explore#1 +1–300 .*≈/))
    expect(text).toContainEqual(expect.stringMatching(/Explore#2 +200–500 .*≈/))
  })
})

describe('per-agent ≈ tokens and exact usage add up', () => {
  const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: 10, ...e }) })
  const usage = (agentId: string | null, input: number, cacheRead: number, cacheCreation: number, output: number): LogRecord => ({
    t: 'usage', ts: 5, agentId, model: 'm', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation },
  })
  const records: LogRecord[] = [
    { t: 'agent', ts: 1, agentId: EXPLORE, agentType: 'Explore' },
    ev({ kind: 'read', path: BIG_PATH, ranges: [[1, 300]], totalLines: 1323, estTokens: 3000, agentId: EXPLORE, agentType: 'Explore' }),
    ev({ kind: 'read', path: BIG_PATH, ranges: [[1, 10]], totalLines: 1323, estTokens: 100 }),
    ev({ kind: 'read', path: SMALL_PATH, ranges: [[1, 40]], totalLines: 40, estTokens: 400 }),
    // A Claude Code fork (no SubagentStart): its loads and usage stay apart, on an `other` line.
    ev({ kind: 'read', path: SMALL_PATH, ranges: [[1, 40]], totalLines: 40, estTokens: 400, agentId: 'fork9' }),
    usage(null, 2, 20_000, 3_000, 500),
    usage(EXPLORE, 3, 0, 9_000, 200),
    usage(null, 2, 23_000, 1_000, 300),
    usage('fork9', 1, 5_000, 0, 50),
  ]

  test('the table rows sum to the session totals, ≈ and = alike', () => {
    const s = replay(records)
    const t = agentTable(s)
    expect(t.rows.map((r) => [r.label, r.estTokens, r.billed, r.usage.output])).toEqual([
      ['main', 500, 47_004, 800],
      ['Explore#1', 3000, 9_003, 200],
    ])
    expect(t.other).toMatchObject({ estTokens: 400, billed: 5_001 })
    const all = [...t.rows, t.other!]
    expect(all.reduce((n, r) => n + r.billed, 0)).toBe(s.billedSum)
    expect(all.reduce((n, r) => n + r.usage.output, 0)).toBe(s.usage.output)
    expect(t.rows.reduce((n, r) => n + r.estTokens, 0)).toBe([...s.files.values()].reduce((n, f) => n + f.estTokens, 0))
    expect(t.total).toMatchObject({ estTokens: 3900, billed: s.billedSum, output: s.usage.output })
  })

  test('the agents view (u) shows them with ≈ on estimates, = and "exact" on usage, and no unmarked figure', () => {
    const text = agentLines(replay(records)).map((l) => l.map((c) => c.text).join(''))
    const joined = text.join('\n')
    expect(joined).toMatch(/main .*≈500 tok.*=47k/)
    expect(joined).toMatch(/Explore#1 .*≈3k tok.*=9k/)
    expect(joined).toMatch(/total .*≈3\.9k tok/)
    expect(joined).toContain('exact')
    expect(joined).toContain('tool.call agentId')
    expect(unmarkedTokenFigures(joined)).toEqual([])
  })

  test('main’s footer gives main’s figures; each agent’s own ≈ and = figures are in the help view', async ($, on) => {
    const h = harness(on)
    host(on)
    // A log a previous process wrote.
    h.put(LOG, serializeLog(records))
    await startSession($, 'resume')
    const ui = await $.ui.mount(pane(100, 16))
    // The footer is one line, `context Nk exact · files ≈N` for the viewpoint (main here);
    // the per-agent ≈ and = figures are in the help view's usage table.
    expect((await screen(ui)).at(-1)!).toMatch(/^context 24k exact · files ≈500\b/)
    await ui.press({ key: 'key:g' })
    expect((await screen(ui)).some((l) => l.startsWith('help '))).toBe(true)
    // The help view (scrolled further down) holds the usage table.
    const help = helpView(replay(records)).map((l) => l.map((c) => c.text).join('')).join('\n')
    expect(help).toMatch(/Explore#1 .*≈3k tok.*=9k/)
  })
})

describe('the live footer names the acting subagent', () => {
  test('while Explore#1 reads big.md the footer says so; it goes once the tag clears', async ($, on) => {
    const h = harness(on)
    host(on)
    spawner(on)
    const answers = new Map<string, (v: unknown) => void>()
    on('tool.call', (_$, e) => new Promise((r) => answers.set(e.tool_use_id ?? '', r)) as never)
    await startSession($)
    await spawn($, on, EXPLORE)
    const ui = await $.ui.mount(pane(100, 16))
    const done = $.tool.call({ tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 300, agentId: EXPLORE, tool_use_id: 'toolu_x' } as never)
    await h.clock.settle()
    await ui.redraw()
    expect((await screen(ui)).join('\n')).toContain('Explore#1 reading big.md')
    answers.get('toolu_x')!(readResult(BIG_PATH, BIG, 1, 300))
    await done
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    expect((await screen(ui)).join('\n')).not.toContain('Explore#1 reading')
  })
})

describe('--resume restores per-agent data', () => {
  test('a resumed process rebuilds the registry, per-agent ranges and ≈ tokens, and per-agent usage', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    spawner(on)
    await startSession($)
    await spawn($, on, EXPLORE)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 300, agentId: EXPLORE }, readResult(BIG_PATH, BIG, 1, 300))
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await $.classic.SubagentStop({ agent_id: EXPLORE, agent_type: 'Explore' } as never)
    await endSession($)
    const before = h.state()
    // A new process: nothing in memory but the log.
    const again = replay(h.records())
    expect(again.registry.get(EXPLORE)).toEqual(before.registry.get(EXPLORE))
    expect(again.registry.get(EXPLORE)).toMatchObject({ label: 'Explore#1', status: 'done' })
    expect(again.files.get(BIG_PATH)!.byAgent.get(EXPLORE)).toEqual(before.files.get(BIG_PATH)!.byAgent.get(EXPLORE))
    expect(agentTable(again)).toEqual(agentTable(before))
  })

  // No switcher row; `a` still steps the viewpoint of a resumed session.
  test('the panel of a resumed session switches viewpoints and shows Explore’s rows', async ($, on) => {
    const h = harness(on)
    host(on)
    h.put(LOG, serializeLog([
      { t: 'agent', ts: 1, agentId: EXPLORE, agentType: 'Explore' },
      { t: 'event', e: makeEvent({ kind: 'read', path: BIG_PATH, source: 'tool', tool: 'Read', ranges: [[1, 300]], totalLines: 1323, estTokens: 3000, agentId: EXPLORE, agentType: 'Explore', ts: 1 }) },
    ]))
    await startSession($, 'resume')
    const ui = await $.ui.mount(pane(60, 16))
    await switchTo(ui, 'main')
    expect(await rowText(ui, BIG_PATH)).toMatch(/^  E .*big\.md +\(≈3k\)$/)
    await switchTo(ui, 'Explore#1')
    expect(await rowText(ui, BIG_PATH)).toMatch(/^[◔◑◕] {2}.*big\.md +≈3k$/)
  })
})

describe('per-agent coverage through edits and loads', () => {
  const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: 10, ...e }) })

  test('a main edit shifts the subagent’s earlier range with the content (+2 at line 100: 150–200 → 152–202)', () => {
    const s = replay([
      { t: 'agent', ts: 1, agentId: EXPLORE, agentType: 'Explore' },
      ev({ kind: 'read', path: BIG_PATH, ranges: [[150, 200]], totalLines: 1323, agentId: EXPLORE, agentType: 'Explore' }),
      ev({ kind: 'edit', tool: 'Edit', path: BIG_PATH, linesAdded: 2, hunks: [{ oldStart: 100, oldLines: 1, newStart: 100, newLines: 3 }] }),
    ])
    const big = s.files.get(BIG_PATH)!
    expect(big.byAgent.get(EXPLORE)!.intervals).toEqual([[152, 202]])
    expect(big.byAgent.get(MAIN)).toMatchObject({ edits: 1, estTokens: 0 })
  })

  test('an instruction file loaded for a subagent (InstructionsLoaded agent_id) is that agent’s, not main’s', async ($, on) => {
    const h = harness(on)
    await startSession($)
    await $.classic.SubagentStart({ agent_id: EXPLORE2, agent_type: 'general-purpose' } as never)
    await $.classic.InstructionsLoaded({ file_path: `${CWD}/sub/CLAUDE.md`, memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: `${CWD}/sub/a.ts`, agent_id: EXPLORE2, agent_type: 'general-purpose' } as never)
    await endSession($)
    const f = h.state().files.get(`${CWD}/sub/CLAUDE.md`)!
    expect([...f.byAgent.keys()]).toEqual([EXPLORE2])
    expect(agentState(h.state(), MAIN).files.get(`${CWD}/sub/CLAUDE.md`)!.via).toEqual(['general-purpose#1'])
  })
})
