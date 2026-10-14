// Claude Code Desktop: the session runs with no terminal of its own, so `command.run`'s presentation describes a
// headless terminal (not fullscreen, 80 columns). The panel opens there anyway and draws on the `desktop` surface.
import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import { CWD, FILES, SMALL, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clientLines } from './rows-client.ts'
import Rows, { type RowsProps } from '../hooks/rows.ts'
import { helpLines } from '../src/view/detail.ts'
import { lineSegments } from '../src/view/draw.ts'
import { defaultPalette } from '../src/palette.ts'

const SMALL_PATH = `${CWD}/small.ts`

function surfaces(on: On, list: readonly string[]) {
  on('session.surfaces', () => ({ value: list as never }))
}

/** The host calls `/ccfiles` makes, with `ui.open` answered by `placed`. */
function opens(on: On, placed: { isPlaced: boolean; reason?: string } = { isPlaced: true }) {
  const opened: unknown[] = []
  on('config.list', () => ({ value: [{ key: 'theme', kind: 'choice', value: 'dark', options: [] }] as never }))
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: placed as never }
  })
  return opened
}

const run = ($: Engine, kind: string, isFullscreen: boolean, columns: number) =>
  $.command.run({ command: 'ccfiles', args: '', origin: { kind }, presentation: { isFullscreen, columns } } as never)

describe('/ccfiles in Claude Code Desktop', () => {
  test('opens the panel though the headless terminal is neither fullscreen nor wide', async ($, on) => {
    harness(on)
    surfaces(on, ['desktop'])
    const opened = opens(on)
    const r = await run($, 'sdk', false, 80)
    expect(r.text).toContain('panel open')
    expect(r.text).not.toContain('/tui fullscreen')
    expect(opened).toEqual([expect.objectContaining({ id: 'ccfiles' })])
  })

  test('a desktop that places no panes gets the engine’s reason, not the terminal fix', async ($, on) => {
    harness(on)
    surfaces(on, ['desktop'])
    opens(on, { isPlaced: false, reason: 'the attached desktop places no panes' })
    const r = await run($, 'sdk', false, 80)
    expect(r.text).toBe('panel not placed (the attached desktop places no panes)')
  })

  test('typed at the terminal, the fullscreen and width checks still apply', async ($, on) => {
    harness(on)
    surfaces(on, ['terminal'])
    const opened = opens(on)
    expect((await run($, 'composer', false, 160)).text).toContain('/tui fullscreen')
    expect((await run($, 'composer', true, 100)).text).toContain('110')
    expect(opened).toEqual([])
  })

  test('the pane draws its tabs and rows on the desktop surface', async ($, on) => {
    harness(on)
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount({ ...pane(60, 16), surface: 'desktop', viewport: { columns: 60, rows: 40, isFullscreen: true } })
    const lines = await screen(ui)
    expect(lines.some((l) => /Tree/.test(l) && /Touched/.test(l))).toBe(true)
    expect(lines.some((l) => /small\.ts/.test(l))).toBe(true)
    await ui.unmount()
  })
})

type Node = { type: string; props: Record<string, unknown>; children: Node[] }
const el = (type: string) => (props: Record<string, unknown> & { children?: unknown[] }) => {
  const { children = [], ...rest } = props
  return { type, props: rest, children: children as Node[] }
}

/** Draws the rows Client the way a surface does, with plain element builders. */
function drawRows(props: RowsProps): Node {
  let state: unknown
  const surface = {
    elements: { Box: el('Box'), Text: el('Text') },
    get state() { return state },
    setState: (s: unknown) => { state = s },
    every: () => () => {},
    onPointer: () => {},
    onKey: () => {},
    post: () => {},
  }
  return (Rows as unknown as (p: RowsProps, s: typeof surface) => Node)(props, surface)
}

// Desktop draws Text in a proportional font: padding with spaces drifts, so every run sits in a Box of its cells.
describe('the cell grid on a proportional font', () => {
  test('on desktop every list line is laid out in cells that add up to the pane width; the terminal gets no grid', async ($, on) => {
    harness(on)
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const desk = await $.ui.mount({ ...pane(60, 16), surface: 'desktop' })
    const drawn = JSON.stringify(await desk.drawn())
    expect(drawn).toContain('"grid":true')
    for (const l of await clientLines(desk)) expect(l.segs.reduce((n, s) => n + (s.w ?? 0), 0)).toBe(60)
    const row = (await clientLines(desk)).find((l) => l.id.endsWith('small.ts'))!
    // The value column (≈ tokens) is right-aligned in its cells, so its right edge lines up down the panel.
    expect(row.segs.find((s) => s.t.startsWith('≈'))?.r).toBe(true)
    await desk.unmount()
    const term = await $.ui.mount(pane(60, 16))
    expect(JSON.stringify(await term.drawn())).not.toContain('"grid":true')
    await term.unmount()
  })

  test('the Client draws each run in a Box as wide as its cells, right-aligned runs at the end of theirs', () => {
    const line = { id: 'a', segs: [{ t: '● ', w: 2 }, { t: 'name.ts', w: 7 }, { t: '   ', w: 3 }, { t: '≈12', w: 3, r: true }] }
    const root = drawRows({ lines: [line], hoverBg: '#333333', bands: {}, grid: true })
    const cells = root.children[0]!.children
    // The padding before the right-aligned figure joins its cells (one Box of 6), so the figure has the room.
    expect(cells.map((c) => [c.type, c.props.width])).toEqual([['Box', 2], ['Box', 7], ['Box', 6]])
    expect(cells[2]!.props.justifyContent).toBe('flex-end')
    expect(cells[1]!.children[0]!.children).toEqual(['name.ts'] as never)
    // Without the grid (the terminal) the runs are plain Text, as before.
    const flat = drawRows({ lines: [line], hoverBg: '#333333', bands: {} })
    expect(flat.children[0]!.children.map((c) => c.type)).toEqual(['Text', 'Text', 'Text', 'Text'])
  })

  test('a bar of block characters draws as filled cells, a partial block as a share of its cell', () => {
    const root = drawRows({ lines: [{ id: '', segs: [{ t: '▕██▌ ▏', w: 6, c: '#88aaff' }] }], hoverBg: '#333333', bands: {}, grid: true })
    const cells = root.children[0]!.children[0]!.children
    expect(cells).toHaveLength(6)
    expect(cells[1]!.children[0]!.props).toMatchObject({ width: '100%', backgroundColor: '#88aaff' })
    expect(cells[3]!.children[0]!.props).toMatchObject({ width: '50%' })
    // The frame's right-eighth hugs the right edge of its cell; the blank stays text.
    expect(cells[0]!.props.justifyContent).toBe('flex-end')
    expect(cells[4]!.children[0]!.type).toBe('Text')
  })
})

// The help and detail views are tables: meanings start in one column, and a meaning that wraps hangs under it.
describe('help and detail tables', () => {
  test('every key meaning starts in the same column, wrapped lines included', () => {
    const lines = helpLines().flatMap((l) => lineSegments(l, 44, defaultPalette('dark')).map((segs) => segs.map((s) => s.text).join('')))
    const at = (h: string) => lines.findIndex((l) => l.trim() === h)
    const keys = lines.slice(at('KEYS') + 1, at('GLYPHS')).filter((l) => l.trim() !== '')
    // Some meaning wraps at 44 columns, so the hanging indent is exercised.
    expect(keys.some((l) => l.startsWith(' '))).toBe(true)
    const col = keys[0]!.search(/ {2}\S/) + 2
    for (const l of keys) expect([l, l[col - 1], l[col] !== ' ']).toEqual([l, ' ', true])
  })
})

describe('column header and totals rows', () => {
  test('the header names the columns and the totals sit on the same right edges as the rows', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(60, 16))
    const lines = (await clientLines(ui)).map((l) => l.segs.map((s) => s.t).join(''))
    expect(lines[0]).toMatch(/^READ +NAME +≈TOKENS$/)
    expect(lines[1]).toMatch(/^ +All files · 1 touched +≈\S+$/)
    const row = lines.find((l) => l.includes('small.ts'))!
    // Every line is the pane's width, so a right-aligned value ends in the last column on all three.
    for (const l of [lines[0]!, lines[1]!, row]) expect(l.length).toBe(60)
    // The names start in one column.
    expect(lines[0]!.indexOf('NAME')).toBe(lines[1]!.indexOf('All files'))
    await ui.unmount()
  })

  test('on desktop the gutter glyphs are vectors over blank cells, one size for every state', async ($, on) => {
    harness(on)
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount({ ...pane(60, 16), surface: 'desktop' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"type":"Svg"')
    // Still reading at this frame: the in-progress ring, as a vector like the rest.
    expect(drawn).toMatch(/"alt":"(in progress|read in full)"/)
    const row = (await clientLines(ui)).find((l) => l.id.endsWith('small.ts'))!
    expect(row.segs[0]!.t.trim()).toBe('')
    await ui.unmount()
  })
})

describe('header icons and keys', () => {
  test('each icon lights alone (its own hover group) and reveals its name under it; r refreshes git', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    const tree = JSON.stringify(await ui.drawn())
    const scopes = [...tree.matchAll(/"scope":"(ccfiles:btn:[a-z]+)"/g)].map((m) => m[1])
    // Each icon's scope appears twice: on its button, and on the hidden label it reveals.
    for (const key of ['help', 'up', 'home', 'refresh', 'follow', 'column', 'collapse']) expect(scopes.filter((s) => s === `ccfiles:btn:${key}`)).toHaveLength(2)
    expect(tree).toContain('Refresh git now (r)')
    expect(await ui.find({ key: 'key:r' })).toMatchObject({ props: { hotkey: 'r' } })
    await ui.unmount()
  })
})

describe('the detail view on desktop', () => {
  test('is drawn as blocks: stat cards, the line strip as a vector, the history table with its columns', async ($, on) => {
    harness(on)
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH, offset: 1, limit: 10 }, readResult(SMALL_PATH, SMALL, 1, 10))
    const ui = await $.ui.mount({ ...pane(60, 30), surface: 'desktop' })
    await ui.press({ key: 'key:j' })
    await ui.press({ key: 'key:d' })
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('"key":"detail"')
    expect(tree).toContain("where the lines read sit in the file")
    for (const s of ['READ', 'TOKENS', 'ACTIVITY', 'HISTORY, NEWEST FIRST', 'TIME', 'ACTION', '≈TOKENS']) expect(tree).toContain(`"${s}"`)
    // No rows Client in the detail view on desktop, and no key or glyph table (that is the help view's).
    expect(tree).not.toContain('"type":"Client"')
    expect(tree).not.toContain('"KEYS"')
    await ui.unmount()
  })
})

describe('where am I: the open view is a tab', () => {
  test('help, usage and a file detail each add an active tab with a ×, which closes it; no list tab is active then', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(60, 20))
    const tabsLine = async () => (await screen(ui)).find((l) => /Tree/.test(l))!
    for (const [key, name] of [['key:g', 'Help'], ['key:u', 'Usage']] as const) {
      await ui.press({ key })
      expect(await tabsLine()).toMatch(new RegExp(` ${name} × *$`))
      expect((await ui.find({ type: 'Text', text: `${name} ×` }))?.props).toMatchObject({ bold: true })
      expect((await ui.find({ type: 'Text', text: 'Tree' }))?.props?.bold).toBeUndefined()
      await ui.press({ key: 'tab:view' })
      expect(await tabsLine()).not.toContain('×')
    }
    // At 39 columns the tab still fits: the file name gives way.
    await ui.unmount()
    const narrow = await $.ui.mount(pane(39, 20))
    await narrow.press({ key: 'key:j' })
    await narrow.press({ key: 'key:d' })
    const line = (await screen(narrow)).find((l) => /Tree/.test(l))!
    expect(line).toContain('×')
    expect(line.trimEnd().length).toBeLessThanOrEqual(39)
    await narrow.unmount()
  })

  test('on desktop every stretched vector is given its height in pixels (else the surface draws it 150 tall)', async ($, on) => {
    harness(on)
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    // One request, so the footer has a context and draws its files bar.
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, model: 'm' } } as never
    })
    await startSession($)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
    await t.call($, { tool: 'Read', file_path: SMALL_PATH, offset: 1, limit: 10 }, readResult(SMALL_PATH, SMALL, 1, 10))
    const ui = await $.ui.mount({ ...pane(60, 30), surface: 'desktop' })
    await ui.press({ key: 'key:j' })
    await ui.press({ key: 'key:d' })
    const svgs: { props: Record<string, unknown> }[] = []
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return
      const node = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
      if (node.type === 'Svg') svgs.push(node as never)
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn())
    // The line strip and the footer's bar, at least.
    expect(svgs.filter((s) => String(s.props.source).includes('width="100%"')).length).toBeGreaterThanOrEqual(2)
    for (const s of svgs) if (String(s.props.source).includes('width="100%"')) expect(typeof s.props.height).toBe('number')
    await ui.unmount()
  })
})

describe('the rows Client stays small enough to draw', () => {
  test('Touched with 60 files on desktop: the Client tree is well under the 100,000-character limit', async ($, on) => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`${CWD}/many/f${String(i).padStart(2, '0')}.ts`, 'x\n'.repeat(40)]))
    harness(on, { ...FILES, ...many })
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    for (const [path, text] of Object.entries(many)) await t.call($, { tool: 'Read', file_path: path, offset: 1, limit: 20 }, readResult(path, text, 1, 20))
    const ui = await $.ui.mount({ ...pane(80, 70), surface: 'desktop' })
    await ui.press({ key: 'tab:touched' })
    const find = (n: unknown): RowsProps | undefined => {
      const node = n as { type?: string; props?: { props?: RowsProps }; children?: unknown[] }
      if (node?.type === 'Client') return node.props?.props
      for (const c of node?.children ?? []) {
        const hit = find(c)
        if (hit) return hit
      }
      return undefined
    }
    const props = find(await ui.drawn())!
    expect(props.lines.filter((l) => l.id).length).toBeGreaterThan(50)
    // A 70-row pane with every row in flight (12 sweeping): 40% under the engine's limit.
    expect(JSON.stringify(drawRows(props)).length).toBeLessThan(60_000)
    await ui.unmount()
  })
})

describe('long names on desktop', () => {
  test('a name is sent whole (the surface cuts it, if at all) and every row keeps its stretching padding', async ($, on) => {
    const long = `${CWD}/mods/ccfiles/hooks/a-rather-long-module-name-for-the-panel.ts`
    harness(on, { ...FILES, [long]: 'x\n'.repeat(40) })
    host(on)
    surfaces(on, ['desktop'])
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: long, offset: 1, limit: 10 }, readResult(long, 'x\n'.repeat(40), 1, 10))
    const ui = await $.ui.mount({ ...pane(48, 20), surface: 'desktop' })
    await ui.press({ key: 'tab:touched' })
    const row = (await clientLines(ui)).find((l) => l.id === `f:${long}`)!
    expect(row.segs.find((s) => s.n)?.t).toBe('mods/ccfiles/hooks/a-rather-long-module-name-for-the-panel.ts')
    expect(row.segs.some((s) => s.f)).toBe(true)
    // The terminal still cuts it to its cells.
    await ui.unmount()
    const term = await $.ui.mount(pane(48, 20))
    await term.press({ key: 'tab:touched' })
    expect((await clientLines(term)).find((l) => l.id === `f:${long}`)!.segs.find((s) => s.n)?.t).toMatch(/…$/)
    await term.unmount()
  })
})

describe('closing a view on desktop', () => {
  test('q closes help in place: the pane is not closed and reopened (that would reset its width)', async ($, on) => {
    harness(on)
    const closed: unknown[] = []
    const opened: unknown[] = []
    on('config.list', () => ({ value: [{ key: 'theme', kind: 'choice', value: 'dark', options: [] }] as never }))
    on('ui.open', (_$, e) => {
      opened.push(e)
      return { value: { isPlaced: true } as never }
    })
    on('ui.close', (_$, e) => {
      closed.push(e)
      return { value: undefined }
    })
    on('ui.log', () => ({ value: undefined }))
    on('ui.focus', () => ({}))
    surfaces(on, ['desktop'])
    await startSession($)
    const ui = await $.ui.mount({ ...pane(60, 20), surface: 'desktop' })
    await ui.press({ key: 'key:g' })
    expect((await screen(ui)).some((l) => /Help ×/.test(l))).toBe(true)
    await ui.press({ key: 'key:q' })
    expect((await screen(ui)).some((l) => /Help ×/.test(l))).toBe(false)
    expect(closed).toEqual([])
    expect(opened).toEqual([])
    await ui.unmount()
  })
})
