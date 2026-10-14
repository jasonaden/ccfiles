// Folder rollups in the right column, the header buttons, the meter's state colour, other agents' figures kept out
// of the viewpoint's totals, the live badge and a subagent's edit, double-click focus and the expanded agents list.
import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { defaultPalette } from '../src/palette.ts'
import { estTokens } from '../src/tokens.ts'
import { rowParts, type Look } from '../src/view/draw.ts'
import { MIN_TAG_MS, treeRows, type Row, type ViewContext } from '../src/view/rows.ts'
import { CWD, SMALL, SUB_A, FILES, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clickRow, clientLines, lineText } from './rows-client.ts'

const T = 1_000_000
const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 60_000, ...e }) })
const dark = defaultPalette('dark')
const look = (extra: Partial<Look> = {}): Look => ({ glyphs: 'plain', value: 'tokens', now: T, ...extra })
const drawnValue = (r: Row | undefined) => (r ? rowParts(r, dark, look(), false).value?.text ?? null : 'no row')

describe('folder rollup in the right column', () => {
  const P = '/p'
  const ADR = `${P}/docs/adr`
  const ONLY = `${ADR}/015-data-retention-policy-docs.md`
  // The fold fixture, cut down: the ADRs folder with siblings and two subfolders, nothing else touched.
  const projectFiles = [ONLY, `${ADR}/003-doc-wiki-format.md`, `${ADR}/README.md`, `${ADR}/drafts/017-draft.md`, `${P}/src/a.ts`, `${P}/src/b.ts`]
  const read = (path: string, tokens: number) => ev({ kind: 'read', path, ranges: [[1, 5]], totalLines: 5, estTokens: tokens })
  const ctx = (records: LogRecord[]): ViewContext => ({ state: replay(records), root: P, home: null, projectFiles, git: null, pending: new Map(), now: T })
  const ui = (...keys: string[]) => ({ expanded: new Set(keys), query: '', sort: 'recent' as const })
  const dir = (rows: Row[], path: string) => rows.find((r) => r.kind === 'dir' && r.path === path)

  test('only 015 read: open docs/ and adr/ show no figure (each equals its only child); the file shows ≈1.2k', () => {
    const rows = treeRows(ctx([read(ONLY, 1200)]), ui(`${P}/docs`, ADR))
    for (const d of [`${P}/docs`, ADR]) {
      expect(dir(rows, d)).toMatchObject({ expanded: true, cells: { tokens: null } })
      expect(drawnValue(dir(rows, d))).toBe(null)
    }
    expect(drawnValue(rows.find((r) => r.path === ONLY))).toBe('≈1.2k')
  })

  test('collapsing adr/ shows the figure on adr/; docs/ (open, still one token-bearing file) stays blank', () => {
    const rows = treeRows(ctx([read(ONLY, 1200)]), ui(`${P}/docs`))
    expect(dir(rows, ADR)).toMatchObject({ expanded: false, cells: { tokens: 1200 } })
    expect(drawnValue(dir(rows, ADR))).toBe('≈1.2k')
    expect(drawnValue(dir(rows, `${P}/docs`))).toBe(null)
    // Collapsed at the top as well: docs/ shows its rollup.
    expect(drawnValue(dir(treeRows(ctx([read(ONLY, 1200)]), ui()), `${P}/docs`))).toBe('≈1.2k')
  })

  test('an open folder with two token-bearing files shows their sum', () => {
    const rows = treeRows(ctx([read(`${P}/src/a.ts`, 300), read(`${P}/src/b.ts`, 500)]), ui(`${P}/src`))
    expect(dir(rows, `${P}/src`)).toMatchObject({ expanded: true, cells: { tokens: 800 } })
    expect(drawnValue(dir(rows, `${P}/src`))).toBe('≈800')
  })

  test('two files in different subfolders: the open parent shows the sum, each open subfolder stays blank', () => {
    const rows = treeRows(ctx([read(ONLY, 1200), read(`${ADR}/drafts/017-draft.md`, 100)]), ui(`${P}/docs`, ADR, `${ADR}/drafts`))
    expect(drawnValue(dir(rows, ADR))).toBe('≈1.3k')
    expect(drawnValue(dir(rows, `${ADR}/drafts`))).toBe(null)
  })
})

describe('meter colour is the state colour; state never rests on colour alone', () => {
  const P = '/p'
  const ctx = (records: LogRecord[]): ViewContext => ({ state: replay(records), root: P, home: '/home/u', projectFiles: [], git: null, pending: new Map(), now: T })
  const ui = { expanded: new Set<string>(), query: '', sort: 'recent' as const }
  const partsOf = (records: LogRecord[], path: string) => {
    const r = treeRows(ctx(records), ui).find((x) => x.path === path)
    if (!r) throw new Error(`no row for ${path}`)
    return rowParts(r, dark, look(), false)
  }
  const a = `${P}/a.ts`
  const readA = ev({ kind: 'read', path: a, ranges: [[1, 10]], totalLines: 10, estTokens: 50, ts: T - 60_000 })
  const cases = {
    read: partsOf([readA], a),
    edit: partsOf([readA, ev({ kind: 'edit', path: a, tool: 'Edit', linesAdded: 1, ts: T - 50_000 })], a),
    commit: partsOf([readA, ev({ kind: 'edit', path: a, tool: 'Edit', linesAdded: 1, ts: T - 50_000 }), ev({ kind: 'commit', path: a, tool: 'git commit', source: 'gitScan', sha: 'abc1234', ts: T - 40_000 })], a),
    instruction: partsOf([ev({ kind: 'autoload', path: `${P}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 })], `${P}/CLAUDE.md`),
  }

  test('the gutter meter takes read, edit, commit and instruction colours', () => {
    for (const [state, parts] of Object.entries(cases)) {
      expect([state, '◔◑◕●'.includes(parts.gutter?.text ?? 'x')]).toEqual([state, true])
      expect([state, parts.gutter?.fg]).toEqual([state, dark.colors[state as keyof typeof cases]])
    }
    expect(new Set(Object.values(cases).map((c) => c.gutter?.fg)).size).toBe(4)
  })

  test('without colour every state still differs: ✎ on the edit, ◆ on the commit, the system icon ⚡ on the load', () => {
    const marks = (k: keyof typeof cases) => cases[k].marks.map((m) => m.text)
    expect(marks('read')).toEqual([])
    expect(marks('edit')).toContain('✎')
    expect(marks('commit')).toContain('◆')
    expect(cases.instruction.icon?.text).toBe('⚡')
    // NO_COLOR: what's left is the text; four states, four different texts.
    const plain = (k: keyof typeof cases) => [cases[k].gutter?.text, cases[k].icon?.text, ...marks(k)].join(' ')
    expect(new Set((Object.keys(cases) as (keyof typeof cases)[]).map(plain)).size).toBe(4)
  })

  test('with nerd glyphs the load keeps a non-colour sign: its system icon, or the ⚡ mark', () => {
    const r = treeRows(ctx([ev({ kind: 'autoload', path: `${P}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 })]), ui).find((x) => x.path === `${P}/CLAUDE.md`)!
    const nerd = rowParts(r, dark, look({ glyphs: 'nerd' }), false)
    const plainFile = rowParts(treeRows(ctx([readA]), ui).find((x) => x.path === a)!, dark, look({ glyphs: 'nerd' }), false)
    expect(nerd.icon?.text).not.toBe(plainFile.icon?.text)
    expect(nerd.marks.map((m) => m.text)).toContain('⚡')
  })
})

/** A repo whose git commands answer and are counted (as git-panel.test.ts does). */
function repo(on: On) {
  const runs: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    runs.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
    if (argv === 'git branch --show-current') return ok('main\n')
    if (argv === 'git rev-parse HEAD') return ok('a'.repeat(40) + '\n')
    return ok('')
  })
  return runs
}

describe('header buttons', () => {
  const SMALL_PATH = `${CWD}/small.ts`
  const dimmed = async (ui: { find: (q: { key: string }) => Promise<{ props?: Record<string, unknown> } | undefined> }, key: string) =>
    (await ui.find({ key: `btn:${key}` }))?.props?.dimColor === true

  test('↻ requests a git refresh: one more `git status` run, held to the 2 s throttle', async ($, on) => {
    const h = harness(on)
    host(on)
    const runs = repo(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(60, 16))
    await $.prompt.submit({ text: 'hi', wait: false } as never)
    await h.clock.settle()
    const status = () => runs.filter((r) => r.startsWith('git status')).length
    const before = status()
    expect(before).toBeGreaterThan(0)
    // Within 2 s of the last run: the press waits for the throttle, then runs once.
    await ui.press({ key: 'btn:refresh' })
    await ui.press({ key: 'btn:refresh' })
    await h.clock.settle()
    expect(status()).toBe(before)
    await h.clock.advance(2100)
    await h.clock.settle()
    expect(status()).toBe(before + 1)
    // Past the throttle: a press runs at once.
    await h.clock.advance(2100)
    await ui.press({ key: 'btn:refresh' })
    await h.clock.settle()
    expect(status()).toBe(before + 2)
  })

  test('? opens the help view and closes it again; the button is bright while it is open', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(60, 16))
    const helpShown = async () => (await screen(ui)).some((l) => /^Help\b/.test(l))
    expect(await helpShown()).toBe(false)
    expect(await dimmed(ui, 'help')).toBe(true)
    await ui.press({ key: 'btn:help' })
    expect(await helpShown()).toBe(true)
    expect(await dimmed(ui, 'help')).toBe(false)
    await ui.press({ key: 'btn:help' })
    expect(await helpShown()).toBe(false)
    expect(await (async () => (await clientLines(ui)).some((l) => l.id === `f:${SMALL_PATH}`))()).toBe(true)
  })

  test('◉ toggles follow: dim while paused, bright again on the next press', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    expect(await dimmed(ui, 'follow')).toBe(false)
    await ui.press({ key: 'btn:follow' })
    expect(await dimmed(ui, 'follow')).toBe(true)
    await ui.press({ key: 'btn:follow' })
    expect(await dimmed(ui, 'follow')).toBe(false)
  })

  test('Σ cycles the right column tokens → lines → date → size → tokens', async ($, on) => {
    const h = harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60, 16))
    const value = async () => {
      const l = (await clientLines(ui)).find((x) => x.id === `f:${SMALL_PATH}`)
      return lineText(l ?? { id: '', segs: [] }).trimEnd().split(/ +/).at(-1)
    }
    const tok = `≈${estTokens(readResult(SMALL_PATH, SMALL).text)}`
    expect(await value()).toBe(tok)
    await ui.press({ key: 'btn:column' })
    expect(await value()).toBe('40/40')
    await ui.press({ key: 'btn:column' })
    const date = await value()
    expect(date).not.toBe(tok)
    expect(date).not.toBe('40/40')
    await ui.press({ key: 'btn:column' })
    expect(await value()).toMatch(/^\d+(\.\d)?[BKMG]$/)
    await ui.press({ key: 'btn:column' })
    expect(await value()).toBe(tok)
  })
})

const EXPLORE = 'a0ccdd61e74e15cd4'

/** Answers agent.spawn in Claude Code's place; register before the first `$` call. */
const spawner = (on: On) => on('agent.spawn', () => ({ model: 'm', agentId: EXPLORE }) as never)

async function spawnExplore($: Engine) {
  await $.classic.SubagentStart({ agent_id: EXPLORE, agent_type: 'Explore' } as never)
  await $.agent.spawn({ tool_use_id: 'toolu_spawn', prompt: 'read', description: 'task', subagentType: 'Explore' } as never)
}

describe('other agents’ reads stay out of the viewpoint’s totals', () => {
  const MINE = `${CWD}/sub/a.ts`
  const THEIRS = `${CWD}/sub/b.ts`
  const SUB_B = SUB_A.replace(/a/g, 'b') + 'export const extra = "only Explore read this file";\n'
  const files = { ...FILES, [THEIRS]: SUB_B }

  test('main reads sub/a.ts, Explore reads sub/b.ts: b shows (≈N); the footer and the sub/ rollup count a only', async ($, on) => {
    const h = harness(on, files)
    host(on)
    spawner(on)
    const t = tools(on)
    await startSession($)
    await spawnExplore($)
    await t.call($, { tool: 'Read', file_path: MINE }, readResult(MINE, SUB_A))
    await t.call($, { tool: 'Read', file_path: THEIRS, agentId: EXPLORE }, readResult(THEIRS, SUB_B))
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(80, 20))
    const mine = estTokens(readResult(MINE, SUB_A).text)
    const theirs = estTokens(readResult(THEIRS, SUB_B).text)
    expect(theirs).not.toBe(mine)
    const row = async (key: string) => lineText((await clientLines(ui)).find((l) => l.id === key) ?? { id: '', segs: [] })
    expect(await row(`f:${THEIRS}`)).toMatch(new RegExp(`b\\.ts +\\(≈${theirs}\\)$`))
    expect(await row(`f:${MINE}`)).toMatch(new RegExp(`a\\.ts +≈${mine}$`))
    // The footer's `≈N from files` is main's own figure: sub/b.ts is not in it.
    expect((await screen(ui)).find((l) => l.includes('from files'))).toMatch(new RegExp(`≈${mine} from files`))
    // Collapse sub/: its rollup is main's sub/a.ts only, not the sum of both.
    const subKey = `d:${CWD}/sub`
    if (!(await row(subKey)).includes('▸')) await clickRow(ui, subKey)
    expect(await row(subKey)).toMatch(new RegExp(`sub +≈${mine}$`))
  })
})

describe('a subagent at work and a subagent’s edit', () => {
  const SMALL_PATH = `${CWD}/small.ts`
  const SUB_PATH = `${CWD}/sub/a.ts`

  test('while Explore reads a file its badge is live (background = read colour); after, it is the dim chip again', async ($, on) => {
    const h = harness(on)
    host(on)
    spawner(on)
    const answers = new Map<string, (v: unknown) => void>()
    on('tool.call', (_$, e) => new Promise((r) => answers.set(e.tool_use_id ?? '', r)) as never)
    await startSession($)
    await spawnExplore($)
    const call = (id: string) => $.tool.call({ tool: 'Read', file_path: SMALL_PATH, agentId: EXPLORE, tool_use_id: id } as never)
    const first = call('toolu_1')
    await h.clock.settle()
    answers.get('toolu_1')!(readResult(SMALL_PATH, SMALL))
    await first
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60, 16))
    const badge = async () => (await clientLines(ui)).find((l) => l.id === `f:${SMALL_PATH}`)?.segs.find((s) => s.t === 'E')
    const idle = await badge()
    expect(idle).toMatchObject({ b: true })
    expect(idle?.bg).not.toBe(dark.colors.read)
    // A second read by Explore, in flight: the badge goes live.
    const second = call('toolu_2')
    await h.clock.settle()
    await ui.redraw()
    expect(await badge()).toMatchObject({ b: true, bg: dark.colors.read })
    answers.get('toolu_2')!(readResult(SMALL_PATH, SMALL))
    await second
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    expect((await badge())?.bg).toBe(idle?.bg)
  })

  test('a file Explore edited shows ✎ and the E badge in main’s view', async ($, on) => {
    const h = harness(on)
    host(on)
    spawner(on)
    const t = tools(on)
    await startSession($)
    await spawnExplore($)
    await t.call($, { tool: 'Edit', file_path: SUB_PATH, old_string: 'a1 = 1', new_string: 'a1 = 2', agentId: EXPLORE }, {
      ref: 1, result: { filePath: SUB_PATH, oldString: 'a1 = 1', newString: 'a1 = 2', structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-export const a1 = 1;', '+export const a1 = 2;'] }] }, text: 'ok', isReadOnly: false,
    })
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60, 16))
    const line = lineText((await clientLines(ui)).find((l) => l.id === `f:${SUB_PATH}`) ?? { id: '', segs: [] })
    // Cell 0 is main's state (blank: main didn't touch it); the badge says who; `✎` follows the name.
    expect(line).toMatch(/^  E .*a\.ts +✎/)
  })
})

describe('double-click focus, timed on the hooks side', () => {
  const MINE = `${CWD}/sub/a.ts`

  test('two presses on a folder within 450 ms focus it and leave it as it was; slower presses only toggle', async ($, on) => {
    const h = harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: MINE }, readResult(MINE, SUB_A))
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60, 16))
    const dir = `d:${CWD}/sub`
    const open = async () => (await clientLines(ui)).some((l) => l.id === `f:${MINE}`)
    expect(await open()).toBe(true)
    // Slow: two separate presses close it and open it again; no focus.
    await clickRow(ui, dir)
    expect(await open()).toBe(false)
    await h.clock.advance(600)
    await clickRow(ui, dir)
    expect(await open()).toBe(true)
    expect((await screen(ui))[0]).not.toMatch(/▸ sub\b/)
    // Fast: a double-click focuses `sub`; the breadcrumb names it and the folder stays as it was.
    await h.clock.advance(600)
    await clickRow(ui, dir)
    await h.clock.advance(100)
    await clickRow(ui, dir)
    expect((await screen(ui))[0]).toMatch(/▸ sub\b/)
    expect(await open()).toBe(true)
  })
})

describe('the expanded agents list scrolls', () => {
  test('more agents than its third of the body: ▾ N more pages down, then ▴ pages back', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    for (let i = 0; i < 12; i++) await $.classic.SubagentStart({ agent_id: `agent${i}`, agent_type: `worker${i}` } as never)
    const ui = await $.ui.mount(pane(60, 18))
    await ui.press({ key: 'agents:caret' })
    expect(await ui.find({ key: 'agentmore:up:btn' })).toBeFalsy()
    expect(await ui.find({ key: 'agentmore:down:btn' })).toBeTruthy()
    const firstShown = async () => (await screen(ui)).find((l) => /worker\d|agent/.test(l) && /^\s+C /.test(l))
    const before = await firstShown()
    await ui.press({ key: 'agentmore:down:btn' })
    expect(await ui.find({ key: 'agentmore:up:btn' })).toBeTruthy()
    expect(await firstShown()).not.toBe(before)
    await ui.press({ key: 'agentmore:up:btn' })
    expect(await firstShown()).toBe(before)
  })
})
