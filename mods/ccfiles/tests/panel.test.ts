import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { contrastRatio, defaultPalette, fillBackground, mix, readableOn, THEME_HINT } from '../src/palette.ts'
import { unmarkedTokenFigures } from '../src/tokens.ts'
import { shimmerBands } from '../src/view/draw.ts'
import { MIN_TAG_MS } from '../src/view/rows.ts'
import { cellWidth } from '../src/view/text.ts'
import { BIG, CWD, FILES, SMALL, SUB_A, bashResult, harness, readResult, startSession, tools } from './harness.ts'
import type { RowLine } from '../hooks/rows.ts'
import { clickRow, clientLines, lineText, rowNode } from './rows-client.ts'

const BIG_PATH = `${CWD}/big.md`
const SMALL_PATH = `${CWD}/small.ts`
const SUB_A_PATH = `${CWD}/sub/a.ts`
const COLORS = '/home/u/.claude/ccfiles.colors.json'
const DARK = defaultPalette('dark')
const LIGHT = defaultPalette('light')

type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[]; text?: string }

/** What a node shows, as the person reads it. */
function textOf(n: unknown): string {
  if (typeof n === 'string') return n
  if (n === null || typeof n !== 'object') return ''
  const node = n as Node
  // The hidden hotkey Buttons sit in a zero-width Box, which draws nothing.
  if (node.type === 'Box' && node.props?.width === 0) return ''
  const kids = node.children ?? []
  // A plain Button draws its hotkey, a colon, then its label or children.
  const hot = node.type === 'Button' && node.props?.hotkey ? `${node.props.hotkey}: ` : ''
  // A Box's gap draws as that many blank cells between its children.
  const gap = node.type === 'Box' && typeof node.props?.gap === 'number' ? ' '.repeat(node.props.gap) : ''
  if (kids.length > 0) return hot + kids.map(textOf).join(gap)
  if (node.type === 'Button') return `${node.props?.hotkey ? `${node.props.hotkey}: ` : ''}${String(node.props?.label ?? '')}`
  if (node.type === 'Input') return `${String(node.props?.label ?? '')} ${String(node.props?.value || node.props?.placeholder || '')}`
  return ''
}

/** All screen text with wrapped lines joined back. */
async function prose(ui: { drawn: () => Promise<unknown> }): Promise<string> {
  return (await screen(ui)).map((l) => l.trimEnd()).join(' ')
}

/** The drawn pane as lines: one per child of the root column. */
async function screen(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const root = (await ui.drawn()) as Node
  // The list is one Client (hooks/rows.ts): one screen line per line it draws.
  return (root.children ?? []).flatMap((c) => {
    const n = c as Node
    if (n.type === 'Client') return ((n.props?.props as { lines?: RowLine[] })?.lines ?? []).map(lineText)
    return [textOf(n)]
  })
}

/** Follow is paused when the `◉` header button is drawn dim. */
async function followDimmed(ui: { find: (q: { key: string }) => Promise<{ props?: Record<string, unknown> } | undefined> }): Promise<boolean> {
  return (await ui.find({ key: 'btn:follow' }))?.props?.dimColor === true
}

/** Cells of a row whose background is `bg`. */
function filledCells(row: Node, bg: string): number {
  return (row.children ?? [])
    .map((c) => c as Node)
    .filter((c) => c.props?.backgroundColor === bg)
    .reduce((n, c) => n + cellWidth(textOf(c)), 0)
}

const pane = (bodyColumns = 60, bodyRows = 16) =>
  ({
    plugin: 'ccfiles',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ccfiles',
    viewport: { columns: 160, rows: 45, isFullscreen: true },
    props: { title: 'ccfiles', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

/** Stubs what the panel asks of Claude Code: its theme, the pane, the log, the clipboard, the focus ring. */
function host(on: On, theme = 'dark') {
  const opened: unknown[] = []
  const closed: unknown[] = []
  const logs: string[] = []
  const copies: string[] = []
  on('config.list', () => ({ value: [{ key: 'theme', kind: 'choice', value: theme, options: [] }] as never }))
  on('ui.open', (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } as never }
  })
  on('ui.log', (_$, e) => {
    logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    copies.push(String((e as { text?: unknown }).text ?? ''))
    return { value: { isCopied: true } as never }
  })
  on('ui.close', (_$, e) => {
    closed.push(e)
    return { value: undefined }
  })
  on('ui.focus', () => ({}))
  return { opened, closed, logs, copies }
}

const runFiles = ($: Engine, isFullscreen: boolean, columns: number) =>
  $.command.run({ command: 'ccfiles', args: '', origin: { kind: 'person' }, presentation: { isFullscreen, columns } } as never)

describe('/ccfiles opens the panel only where it can dock', () => {
  test('refuses outside fullscreen and under 110 columns, with the reason and the fix; opens otherwise', async ($, on) => {
    harness(on)
    const h = host(on)
    const notFull = await runFiles($, false, 160)
    expect(notFull.text).toContain('/tui fullscreen')
    const narrow = await runFiles($, true, 100)
    expect(narrow.text).toContain('110')
    expect(narrow.text).toContain('100')
    expect(h.opened).toEqual([])
    const ok = await runFiles($, true, 110)
    expect(ok.text).toContain('panel open')
    expect(h.opened).toEqual([expect.objectContaining({ id: 'ccfiles', focus: true })])
  })
})

// The strip draws ` Tree`, ` Touched N`, ` Instructions N` with no `1: ` hotkey prefix;
// the active tab is bold accent, underlined, on the selection; 1/2/3 are hidden hotkeys.
describe('tabs', () => {
  test('Tree | Touched | Instructions, Tree first; 1/2/3 switch', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane())
    const tabs = (await screen(ui)).find((l) => /Tree/.test(l))!
    expect(tabs).toMatch(/^ Tree +Touched \d+ +Instructions \d+ /)
    // The label is its own Text (the pad cells around it are not underlined).
    const active = async (label: string) => (await ui.find({ type: 'Text', text: label }))?.props
    expect(await active('Tree')).toMatchObject({ bold: true, underline: true, color: DARK.colors.accent, backgroundColor: DARK.colors.selection })
    expect(await active('Touched')).toMatchObject({ color: DARK.colors.text })
    expect((await active('Touched'))?.bold).toBeUndefined()
    expect((await ui.find({ key: 'tab:touched' }))?.props?.hotkey).toBeUndefined()
    await ui.press({ key: 'key:3' })
    expect(await active('Instructions')).toMatchObject({ bold: true, underline: true })
    await ui.press({ key: 'key:2' })
    expect(await active('Touched')).toMatchObject({ bold: true })
    await ui.press({ key: 'tab:tree' })
    expect(await active('Tree')).toMatchObject({ bold: true })
  })
})

describe('rows', () => {
  // The fill is drawn only with `coverage: fill`.
  test('single-line rows; the read fill is round(coverage × width) ±1 at several widths; no exact ranges in rows; the detail view has them', { options: { coverage: 'fill' } }, async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    for (const width of [39, 40, 57, 71, 96]) {
      const ui = await $.ui.mount(pane(width))
      const big = (await rowNode(ui, `f:${BIG_PATH}`)) as Node
      expect(Math.abs(filledCells(big, fillBackground(DARK)) - Math.round((200 / 1323) * width))).toBeLessThan(2)
      const small = (await rowNode(ui, `f:${SMALL_PATH}`)) as Node
      expect(filledCells(small, fillBackground(DARK))).toBe(width)
      for (const row of [big, small]) {
        const text = textOf(row)
        expect(cellWidth(text)).toBe(width)
        expect(text).not.toContain('\n')
        expect(text).not.toMatch(/\d+–\d+/)
      }
      await ui.unmount()
    }
    const ui = await $.ui.mount(pane(71, 30))
    await clickRow(ui, `f:${BIG_PATH}`)
    const detail = (await screen(ui)).join('\n')
    expect(detail).toContain('1–200 / 1,323 · 15%')
    expect(detail).toContain('≈ estimated (chars ÷ 4)')
  })

  test('the detail view shows read vs authored lines, history, load reason and fallback notes', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }) as never)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH, offset: 1, limit: 5 }, readResult(SMALL_PATH, SMALL, 1, 5))
    const small = SMALL.split('\n')
    const patch = [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 8, lines: [...small.slice(0, 3).map((l) => ' ' + l), '+a', '+b', ...small.slice(3, 6).map((l) => ' ' + l)] }]
    await t.call($, { tool: 'Edit', file_path: SMALL_PATH, old_string: 'x', new_string: 'y' }, { ref: 1, result: { filePath: SMALL_PATH, structuredPatch: patch }, text: 'updated' })
    const ui = await $.ui.mount(pane(71, 30))
    await clickRow(ui, `f:${SMALL_PATH}`)
    const detail = (await screen(ui)).join('\n')
    expect(detail).toContain('1–7 / 42')
    expect(detail).toMatch(/read +1–3, 6–7/)
    expect(detail).toMatch(/authored +4–5/)
    expect(detail).toMatch(/Read 1–5 ≈\d+ tok main/)
    expect(detail).toMatch(/Edit edit \+2 −0/)
  })
})

describe('project root', () => {
  test('a compaction after `cd sub` does not move the project root: rows stay relative to the session start', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    // 2.1.295: the compact SessionStart carries the Bash shell's directory, not the project's.
    await $.classic.SessionStart({ source: 'compact', transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl', cwd: `${CWD}/sub` } as never)
    const ui = await $.ui.mount(pane(90, 20))
    await ui.press({ key: 'tab:touched' })
    const lines = (await screen(ui)).map((l) => l.trimEnd())
    expect(lines.some((l) => / small\.ts /.test(l + ' '))).toBe(true)
    expect(lines.join('\n')).not.toContain(CWD + '/')
  })

  test('a module reloaded mid-session (no SessionStart) takes the project root, not the shell directory', async ($, on) => {
    // The session cwd follows a Bash cd; the root doesn't.
    harness(on, FILES, undefined, { sessionCwd: `${CWD}/sub` })
    host(on)
    const t = tools(on)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const ui = await $.ui.mount(pane(90, 20))
    await ui.press({ key: 'tab:touched' })
    expect((await screen(ui)).join('\n')).not.toContain(CWD + '/')
  })
})

describe('out of context since compaction', () => {
  test('the detail view of a dropped file says so and keeps its ranges; a re-injected file shows what it holds in context now', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    on('prompt.attachment', (_$, e) => ({ text: e.text }))
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 150, limit: 51 }, readResult(BIG_PATH, BIG, 150, 51))
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await startSession($, 'compact')
    const body = SMALL.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')
    await $.prompt.attachment({ type: 'file', text: `Called the Read tool with the following input: {"file_path":"${SMALL_PATH}"}\nResult of calling the Read tool:\n${body}`, origin: { kind: 'engine' } } as never)
    const ui = await $.ui.mount(pane(90, 30))
    await ui.press({ key: 'tab:touched' })
    await clickRow(ui, `f:${BIG_PATH}`)
    const big = (await screen(ui)).join('\n')
    expect(big).toContain('150–200 / 1,323')
    expect(big).toContain('⊘ out of context since compaction')
    await ui.press({ key: 'key:d' })
    await clickRow(ui, `f:${SMALL_PATH}`)
    const small = (await screen(ui)).join('\n')
    expect(small).not.toContain('out of context')
    expect(small).toMatch(/context +≈\S+ tok in context now/)
  })
})

describe('no unmarked token figure anywhere', () => {
  test('every tab and the detail view: token numbers carry ≈, = or (exact)', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }) as never)
    on('prompt.attachment', (_$, e) => ({ text: e.text }))
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 155, cache_read_input_tokens: 25283, cache_creation_input_tokens: 22477, model: 'm' } } as never
    })
    await startSession($)
    await $.prompt.context({ blocks: [], instructionFiles: [{ path: `${CWD}/CLAUDE.md`, kind: 'project', content: '# x\n' }] } as never)
    await $.prompt.attachment({ type: 'skill_listing', text: 'Skills:\n- demo: d\n- marketing:seo: s', origin: { kind: 'engine' } } as never)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await t.call($, { tool: 'Bash', command: 'head -n 5 sub/a.ts' }, bashResult(SUB_A.split('\n').slice(0, 5).join('\n')))
    const ui = await $.ui.mount(pane(90, 30))
    const seen: string[] = []
    for (const tab of ['tab:touched', 'tab:instructions', 'tab:tree']) {
      await ui.press({ key: tab })
      const text = (await screen(ui)).join('\n')
      seen.push(text)
      expect(unmarkedTokenFigures(text)).toEqual([])
    }
    // The footer spells out `exact` (`context 48k exact`); rows drop `tok`.
    expect(seen.join('\n')).toMatch(/context \d+k exact/)
    expect(seen.join('\n')).toMatch(/≈\d/)
    // Each view that shows an = figure shows its legend; = never marks an estimate.
    for (const text of seen) {
      if (/=\d/.test(text)) expect(text).toContain('= exact')
      expect(text).not.toMatch(/=\S+ tok/)
    }
    await clickRow(ui, `f:${BIG_PATH}`)
    const detail = (await screen(ui)).join('\n')
    expect(unmarkedTokenFigures(detail)).toEqual([])
    expect(detail).toMatch(/\d tok \(exact\)/)
    expect(detail).toContain('= exact (API usage)')
  })
})

// One footer line, `context Nk exact · files ≈N`; `billed ∑` is in the help view.
describe('footer', () => {
  test('the drawn pane ends in one footer line that leads with context; no billed ∑; nothing wraps or cuts at 39–100 columns', async ($, on) => {
    harness(on)
    host(on)
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 881, cache_read_input_tokens: 65_430, cache_creation_input_tokens: 607, model: 'm' } } as never
    })
    await startSession($)
    for (const index of [0, 1]) {
      const stream = $.turn.step({ turnId: 't', index, model: 'm', messageCount: 1 })
      for await (const _ of stream) void _
      await stream.result
    }
    for (const width of [39, 40, 60, 75, 100]) {
      const ui = await $.ui.mount(pane(width, 20))
      const lines = (await screen(ui)).map((l) => l.trimEnd())
      expect(lines).toHaveLength(20)
      const footer = lines.at(-1)!
      expect(footer).toMatch(/^context 66k exact · files ≈\d/)
      expect(cellWidth(footer)).toBeLessThanOrEqual(width)
      expect(footer).not.toContain('…')
      expect(lines.join('\n')).not.toContain('billed')
      expect((await ui.find({ type: 'Text', text: 'context 66k' }))?.props).toMatchObject({ bold: true })
      await ui.unmount()
    }
  })
})

describe('palette config and theme', () => {
  // Needs `coverage: fill`, the only mode that draws the fill.
  test('changing read and fill.darkness in the config file recolors the row on the next render', { options: { coverage: 'fill' } }, async ($, on) => {
    const h = harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60))
    const glyph = async () => ((await rowNode(ui, `f:${BIG_PATH}`)) as Node).children!.map((c) => c as Node)[0]!.props!
    expect(await glyph()).toMatchObject({ color: DARK.colors.read, backgroundColor: fillBackground(DARK) })
    // A custom color that reads on the fill (an unreadable one is swapped for the text color).
    h.put(COLORS, JSON.stringify({ read: '#ffffd0', 'fill.darkness': 0.5 }))
    await h.clock.advance(2100)
    await ui.redraw()
    expect(await glyph()).toMatchObject({ color: '#ffffd0', backgroundColor: mix(DARK.colors.fill, '#000000', 0.5) })
  })

  test('one bad key logs one warning and keeps its default; a malformed file draws the default palette', async ($, on) => {
    const h = harness(on)
    const host$ = host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await h.clock.advance(MIN_TAG_MS)
    h.put(COLORS, JSON.stringify({ edit: 'notacolor', read: '#ffc8a0' }))
    const ui = await $.ui.mount(pane(60))
    const glyph = async () => ((await rowNode(ui, `f:${BIG_PATH}`)) as Node).children!.map((c) => c as Node)[0]!.props!
    expect((await glyph()).color).toBe('#ffc8a0')
    expect(host$.logs.filter((l) => l.includes('edit'))).toHaveLength(1)
    await h.clock.advance(2100)
    await ui.redraw()
    expect(host$.logs).toHaveLength(1)
    h.put(COLORS, '{ not json')
    await h.clock.advance(2100)
    await ui.redraw()
    expect((await glyph()).color).toBe(DARK.colors.read)
  })

  test('config theme: light wins; Claude Code light → light; auto → dark plus the hint in the detail view', async ($, on) => {
    const h = harness(on)
    let theme = 'auto'
    on('config.list', () => ({ value: [{ key: 'theme', kind: 'choice', value: theme, options: [] }] as never }))
    on('ui.log', () => ({ value: undefined }))
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await h.clock.advance(MIN_TAG_MS)
    const ui = await $.ui.mount(pane(60, 30))
    const glyph = async () => ((await rowNode(ui, `f:${BIG_PATH}`)) as Node).children!.map((c) => c as Node)[0]!.props!
    expect((await glyph()).color).toBe(DARK.colors.read)
    await clickRow(ui, `f:${BIG_PATH}`)
    expect(await prose(ui)).toContain(THEME_HINT)
    await ui.press({ key: 'key:d' })
    theme = 'light-daltonized'
    await h.clock.advance(2100)
    await ui.redraw()
    expect((await glyph()).color).toBe(LIGHT.colors.read)
    theme = 'dark'
    h.put(COLORS, JSON.stringify({ theme: 'light' }))
    await h.clock.advance(2100)
    await ui.redraw()
    expect((await glyph()).color).toBe(LIGHT.colors.read)
    await clickRow(ui, `f:${BIG_PATH}`)
    expect(await prose(ui)).not.toContain('Theme unknown')
  })
})

describe('fill strength by colour depth', () => {
  const fillOf = async (ui: Parameters<typeof rowNode>[0]) => ((await rowNode(ui, `f:${BIG_PATH}`)) as Node).children!.map((c) => c as Node)[0]!.props!.backgroundColor
  const run = async ($: Engine, on: On, env: Record<string, string>) => {
    const h = harness(on)
    host(on)
    mock.env(on, env)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    return { ui: await $.ui.mount(pane(60)), h }
  }

  // Fill by colour depth needs `coverage: fill`.
  test('truecolor (COLORTERM=truecolor, outside tmux): the subtle ~30% tint', { options: { coverage: 'fill' } }, async ($, on) => {
    const { ui } = await run($, on, { COLORTERM: 'truecolor', TERM: 'xterm-256color' })
    expect(await fillOf(ui)).toBe(fillBackground(defaultPalette('dark', 'truecolor')))
  })

  test('inside tmux without CLAUDE_CODE_TMUX_TRUECOLOR: the saturated 256-colour set', { options: { coverage: 'fill' } }, async ($, on) => {
    const { ui } = await run($, on, { COLORTERM: 'truecolor', TERM: 'tmux-256color', TMUX: '/tmp/tmux-0/default,1,0' })
    expect(await fillOf(ui)).toBe(fillBackground(DARK))
  })

  test('inside tmux with CLAUDE_CODE_TMUX_TRUECOLOR=1: the subtle tint', { options: { coverage: 'fill' } }, async ($, on) => {
    const { ui } = await run($, on, { COLORTERM: 'truecolor', TERM: 'tmux-256color', TMUX: '/tmp/tmux-0/default,1,0', CLAUDE_CODE_TMUX_TRUECOLOR: '1' })
    expect(await fillOf(ui)).toBe(fillBackground(defaultPalette('dark', 'truecolor')))
  })

  test('fill.darkness in the colors file overrides the truecolor default on the next render', { options: { coverage: 'fill' } }, async ($, on) => {
    const { ui, h } = await run($, on, { COLORTERM: 'truecolor' })
    h.put(COLORS, JSON.stringify({ 'fill.darkness': 0.5 }))
    await h.clock.advance(2100)
    await ui.redraw()
    expect(await fillOf(ui)).toBe(mix(DARK.colors.fill, DARK.background, 0.5))
  })
})

describe('panel background', () => {
  test('dark uses the terminal background; light over a dark Claude Code theme paints a light panel, not light blocks on dark', async ($, on) => {
    const h = harness(on)
    host(on, 'dark')
    await startSession($)
    const ui = await $.ui.mount(pane(60))
    expect(((await ui.drawn()) as Node).props?.backgroundColor).toBeUndefined()
    h.put(COLORS, JSON.stringify({ theme: 'light' }))
    await h.clock.advance(2100)
    await ui.redraw()
    expect(((await ui.drawn()) as Node).props).toMatchObject({ backgroundColor: LIGHT.background })
  })
})

describe('light theme paints every cell', () => {
  type Cell = { text: string; fg?: string; bg?: string; where: string }
  /** Every drawn run of text with the background it lands on (its own, else the nearest Box's or the Client's). */
  function cells(n: unknown, bg: string | undefined, where: string, out: Cell[] = []): Cell[] {
    if (typeof n === 'string') {
      if (n !== '') out.push({ text: n, bg, where })
      return out
    }
    if (n === null || typeof n !== 'object') return out
    const node = n as Node
    const key = String(node.key ?? node.props?.key ?? where)
    if (node.type === 'Client') {
      const props = node.props?.props as { lines: RowLine[]; bg?: string }
      for (const l of props.lines) for (const sg of l.segs) out.push({ text: sg.t, fg: sg.c, bg: sg.bg ?? props.bg, where: `rows ${l.id || '(line)'}` })
      return out
    }
    const own = (node.props?.backgroundColor as string | undefined) ?? bg
    if (node.type === 'Text') {
      for (const c of node.children ?? []) {
        if (typeof c === 'string') out.push({ text: c, fg: node.props?.color as string | undefined, bg: own, where: key })
        else cells(c, own, key, out)
      }
      return out
    }
    for (const c of node.children ?? []) cells(c, own, key, out)
    return out
  }

  test('rows, header, footer, legend, detail and padding all sit on the light background, every text at 4.5:1', async ($, on) => {
    harness(on)
    host(on, 'light')
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, model: 'm' } } as never
    })
    const t = tools(on)
    await startSession($)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    const ui = await $.ui.mount(pane(60, 30))
    const views: [string, unknown][] = [['list', await ui.drawn()]]
    await clickRow(ui, `f:${BIG_PATH}`)
    views.push(['detail', await ui.drawn()])
    for (const [name, tree] of views) {
      expect((tree as Node).props?.backgroundColor).toBe(LIGHT.background)
      const all = cells(tree, undefined, 'root')
      expect(all.length).toBeGreaterThan(10)
      for (const c of all) {
        if (c.bg === undefined) throw new Error(`${name}: “${c.text}” in ${c.where} has no background`)
        if (c.text.trim() === '' || !c.fg || !c.fg.startsWith('#')) continue
        const r = contrastRatio(c.fg, c.bg)
        if (r < 4.5) throw new Error(`${name}: “${c.text}” ${c.fg} on ${c.bg} in ${c.where}: ${r.toFixed(2)}`)
      }
      // Nothing is drawn on the dark variant's background.
      expect(all.some((c) => c.bg === DARK.background)).toBe(false)
    }
  })
})

describe('live behavior', () => {
  const MANY = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${CWD}/many/f${String(i).padStart(2, '0')}.ts`, 'x\n']))

  // Pending = `◌` and the name shimmers (no `reading` tag); settled = the state glyph and the name
  // in its static state colour, no `read` word; faded = the name back in its git colour (touched, clean: `text`).
  test('pending while the call runs, settled on the result, faded after ~2.7 s', async ($, on) => {
    const h = harness(on)
    host(on)
    let release: (v: unknown) => void = () => {}
    on('tool.call', () => new Promise((r) => (release = r)) as never)
    await startSession($)
    const ui = await $.ui.mount(pane(60))
    const call = $.tool.call({ tool: 'Read', file_path: SMALL_PATH, tool_use_id: 'toolu_p' } as never)
    await h.clock.settle()
    await ui.redraw()
    const line = async () => (await clientLines(ui)).find((l) => l.id === `f:${SMALL_PATH}`)!
    const name = (l: RowLine) => l.segs.find((x) => x.t === 'small.ts')!
    const pending = await line()
    expect(lineText(pending)).toMatch(/^◌ /)
    expect(pending.sh).toBe('read')
    expect(lineText(pending)).not.toContain('reading')
    release(readResult(SMALL_PATH, SMALL))
    await call
    // The shimmer lasts at least MIN_TAG_MS, then the row settles on the result.
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    const settled = await line()
    expect(settled.sh).toBeUndefined()
    expect(lineText(settled)).toMatch(/^● .*small\.ts +≈\d+ *$/)
    expect(lineText(settled)).not.toMatch(/ read\b/)
    expect(name(settled).c).toBe(readableOn(DARK.colors.read, name(settled).bg ?? DARK.background, DARK))
    await h.clock.advance(2800 - MIN_TAG_MS)
    await ui.redraw()
    const faded = await line()
    expect(name(faded).c).toBe(readableOn(DARK.colors.text, name(faded).bg ?? DARK.background, DARK))
    expect(lineText(faded)).toMatch(/^● /)
  })

  test('follow reveals and scrolls to the latest file; a manual scroll pauses it; f resumes', async ($, on) => {
    harness(on, { ...FILES, ...MANY })
    host(on)
    const t = tools(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 14))
    const shown = async (path: string) => (await rowNode(ui, `f:${path}`)) !== undefined
    const f39 = `${CWD}/many/f39.ts`
    await t.call($, { tool: 'Read', file_path: f39 }, readResult(f39, 'x\n'))
    await ui.redraw()
    expect(await shown(f39)).toBe(true)
    // Open the untouched files of many/ so the list is longer than the pane, then scroll to its end.
    await clickRow(ui, `u:${CWD}/many`)
    await $.ui.scroll({ component: 'Pane', requestId: 'ccfiles', offset: 0, by: 100, bodyRows: 14, contentRows: 60, origin: { kind: 'person' } } as never)
    // Paused follow dims the `◉` header button; no `follow paused (f)` text.
    expect(await followDimmed(ui)).toBe(true)
    expect((await screen(ui)).join('\n')).not.toContain('follow paused')
    const f38 = `${CWD}/many/f38.ts`
    await t.call($, { tool: 'Read', file_path: f38 }, readResult(f38, 'x\n'))
    await ui.redraw()
    // Paused: the window stays at the end (f38 left the fold for the top); the lit row is counted on the fixed
    // ⋮ line instead of pinned.
    expect(await shown(f38)).toBe(false)
    expect((await screen(ui)).join('\n')).toMatch(/⋮ \d+ more · \d+ active/)
    await ui.press({ key: 'key:f' })
    expect(await followDimmed(ui)).toBe(false)
  })
})

describe('rows Client', () => {
  type T = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const clientRows = async (ui: { drawn: (s?: never) => Promise<unknown> }) => ((await ui.drawn({ in: 'rows' } as never)) as T).children as T[]
  const rowText = (r: T) => (r.children as T[]).map((t) => (t.children as string[]).join('')).join('')

  test('draws every line exactly as laid out, each the pane width; no stray border column', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    for (const width of [39, 44, 60, 90]) {
      const ui = await $.ui.mount(pane(width, 18))
      const lines = await clientLines(ui)
      const drawn = await clientRows(ui)
      expect(drawn).toHaveLength(lines.length)
      drawn.forEach((r, i) => {
        expect(rowText(r)).toBe(lineText(lines[i]!))
        expect(cellWidth(rowText(r))).toBe(width)
        expect(rowText(r)).not.toMatch(/[│┃]$/)
      })
      await ui.unmount()
    }
  })

  test('hover lights the row under the pointer; a right click copies its path; dragging scrolls and pauses follow', async ($, on) => {
    harness(on, { ...FILES, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${CWD}/many/f${String(i).padStart(2, '0')}.ts`, 'x\n'])) })
    const h = host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 12))
    await clickRow(ui, `d:${CWD}/many`)
    const lines = await clientLines(ui)
    const y = lines.findIndex((l) => l.id === `f:${CWD}/many/f00.ts`)
    await ui.pointer({ type: 'move', x: 5, y, in: 'rows' } as never)
    const drawn = await clientRows(ui)
    const bgs = (r: T) => (r.children as T[]).map((x) => x.props?.backgroundColor as string | undefined)
    // Hover is a faint wash, fainter than the selection, on the hovered row only.
    const hover = bgs(drawn[y]!).find((c) => c !== undefined)!
    expect(hover).toBeDefined()
    expect(bgs(drawn[y]!).every((c) => c === hover)).toBe(true)
    expect(hover).not.toBe(DARK.colors.selection)
    expect(contrastRatio(hover, DARK.background)).toBeGreaterThan(1)
    expect(contrastRatio(hover, DARK.background)).toBeLessThan(contrastRatio(DARK.colors.selection, DARK.background))
    expect(bgs(drawn[y + 1]!)).not.toContain(hover)
    await ui.pointer({ type: 'down', x: 5, y, button: 'right', in: 'rows' } as never)
    expect(h.copies).toEqual([`${CWD}/many/f00.ts`])
    const before = await clientLines(ui)
    await ui.pointer({ type: 'down', x: 5, y: 6, button: 'left', in: 'rows' } as never)
    await ui.pointer({ type: 'move', x: 5, y: 2, button: 'left', in: 'rows' } as never)
    await ui.pointer({ type: 'up', x: 5, y: 2, button: 'left', in: 'rows' } as never)
    const after = await clientLines(ui)
    expect(after[0]!.id).not.toBe(before[0]!.id)
    // The `◉` button dims; no `follow paused (f)` text.
    expect(await followDimmed(ui)).toBe(true)
    expect((await screen(ui)).join('\n')).not.toContain('follow paused')
  })

  test('the detail view is drawn by the same Client, so it keeps the keys after a click: d closes it, j/k scroll it', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    const ui = await $.ui.mount(pane(60, 12))
    await clickRow(ui, `f:${BIG_PATH}`)
    const detail = (await clientLines(ui)).map(lineText)
    expect(detail.join('\n')).toContain('1–200 / 1,323')
    await ui.key({ key: 'j', in: 'rows' } as never)
    expect((await clientLines(ui)).map(lineText)[0]).toBe(detail[1])
    await ui.key({ key: 'k', in: 'rows' } as never)
    await ui.key({ key: 'd', in: 'rows' } as never)
    expect((await clientLines(ui)).some((l) => l.id === `f:${BIG_PATH}`)).toBe(true)
  })

  test('the Instructions summary is drawn once, and the pane is exactly its body height', async ($, on) => {
    harness(on)
    host(on)
    on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }) as never)
    await startSession($)
    await $.prompt.context({ blocks: [], instructionFiles: [{ path: `${CWD}/CLAUDE.md`, kind: 'project', content: '# x\n' }] } as never)
    const ui = await $.ui.mount(pane(60, 16))
    await ui.press({ key: 'tab:instructions' })
    const lines = await screen(ui)
    expect(lines.filter((l) => /^\d+ auto · /.test(l))).toHaveLength(1)
    expect(lines).toHaveLength(16)
  })

  // The band sweeps the file name only. `coverage: fill` so the settled fill is still checked.
  test('the band sweeps the name in the state colour, never the rest of the row, then settles to the fill', { options: { coverage: 'fill' } }, async ($, on) => {
    const hh = harness(on)
    host(on)
    let release: (v: unknown) => void = () => {}
    on('tool.call', () => new Promise((r) => (release = r)) as never)
    await startSession($)
    const width = 60
    const ui = await $.ui.mount(pane(width))
    const call = $.tool.call({ tool: 'Read', file_path: SUB_A_PATH, tool_use_id: 'toolu_s' } as never)
    await hh.clock.settle()
    await ui.redraw()
    const line = (await clientLines(ui)).find((l) => l.id === `f:${SUB_A_PATH}`)!
    expect(line.sh).toBe('read')
    const y = (await clientLines(ui)).findIndex((l) => l.id === line.id)
    const band = new Set(shimmerBands(DARK).read.map((b) => b.bg))
    const text = lineText(line)
    const from = cellWidth(text.slice(0, text.indexOf(' a.ts') + 1))
    const tag = [from, from + 'a.ts'.length]
    const lit = new Set<number>()
    for (let frame = 0; frame < 40; frame++) {
      let col = 0
      for (const cell of (await clientRows(ui))[y]!.children as T[]) {
        const text = (cell.children as string[]).join('')
        if (band.has(cell.props?.backgroundColor as string)) for (let i = 0; i < cellWidth(text); i++) lit.add(col + i)
        col += cellWidth(text)
      }
      expect(col).toBe(width)
      await ui.advance(90)
    }
    expect([...lit].sort((a, b) => a - b)).toEqual(Array.from({ length: tag[1]! - tag[0]! }, (_, i) => tag[0]! + i))
    release(readResult(SUB_A_PATH, SUB_A))
    await call
    await hh.clock.advance(2800)
    await ui.redraw()
    const settled = (await clientLines(ui)).find((l) => l.id === `f:${SUB_A_PATH}`)!
    expect(settled.sh).toBeUndefined()
    // Settled: the muted read fill, no band colour left.
    expect(settled.segs.some((x) => x.bg === fillBackground(DARK))).toBe(true)
    expect(settled.segs.some((x) => x.bg !== undefined && band.has(x.bg))).toBe(false)
  })

  test('no timer runs while nothing is lit (rule 5)', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60))
    const before = (await clientLines(ui)).map(lineText)
    await ui.advance(900)
    expect((await clientLines(ui)).map(lineText)).toEqual(before)
    expect((await clientLines(ui)).some((l) => l.sh)).toBe(false)
  })
})

describe('big projects', () => {
  test('a slow project walk stops at its budget inside a render and finishes in the background', async ($, on) => {
    const dirs = Array.from({ length: 400 }, (_, i) => `d${String(i).padStart(3, '0')}`)
    // Answer the walk slowly: 2 ms per directory, 400 directories.
    const h = harness(on, FILES, (path) => {
      if (!path.startsWith(CWD)) return null
      const until = Date.now() + 2
      while (Date.now() < until) {}
      if (path === CWD) return dirs.map((name) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }))
      return [{ name: 'x.ts', kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }]
    })
    host(on)
    await startSession($)
    const started = Date.now()
    const ui = await $.ui.mount(pane(60, 12))
    expect(Date.now() - started).toBeLessThan(600)
    await ui.input({ key: 'search', text: 'd399', kind: 'change' })
    expect(await rowNode(ui, `d:${CWD}/d399`)).toBeUndefined()
    for (let i = 0; i < 100; i++) await h.clock.advance(20)
    await ui.redraw()
    expect(await rowNode(ui, `d:${CWD}/d399`)).toBeDefined()
  })
})

describe('search and keys', () => {
  test('typing filters paths; Enter reveals and jumps to the first hit; c clears and the hit stays revealed', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    expect(await rowNode(ui, `f:${SUB_A_PATH}`)).toBeUndefined()
    await ui.input({ key: 'search', text: 'a.t', kind: 'change' })
    const filtered = (await screen(ui)).slice(2).filter((l) => l.trim() !== '')
    expect(filtered.some((l) => l.includes('big.md'))).toBe(false)
    expect(await rowNode(ui, `f:${SUB_A_PATH}`)).toBeDefined()
    await ui.input({ key: 'search', text: 'a.t' })
    await ui.press({ key: 'key:c' })
    const row = (await rowNode(ui, `f:${SUB_A_PATH}`)) as Node
    expect(row).toBeDefined()
    expect((row.children![0] as Node).props?.backgroundColor).toBe(DARK.colors.selection)
    expect(await rowNode(ui, `f:${BIG_PATH}`)).toBeDefined()
  })

  // The search control sits at the tab strip's right end with no `s:` label; its placeholder names the active filter.
  test('the search control: no key label, `/ search`, the active filter after Enter, cleared by c', async ($, on) => {
    harness(on)
    host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    const field = async () => (await ui.find({ key: 'search' }))!.props as { label?: string; placeholder?: string; value?: string }
    expect(await field()).toMatchObject({ placeholder: '/ search', value: '' })
    expect((await field()).label).toBeUndefined()
    await ui.input({ key: 'search', text: 'a.t', kind: 'change' })
    expect(await field()).toMatchObject({ value: 'a.t' })
    await ui.input({ key: 'search', text: 'a.t' })
    expect(await field()).toMatchObject({ value: '', placeholder: '/ “a.t”', submitLabel: 'jump' })
    expect((await screen(ui)).find((l) => /Tree/.test(l))).toMatch(/\/ “a\.t”$/)
    await ui.press({ key: 'key:c' })
    expect(await field()).toMatchObject({ placeholder: '/ search' })
  })

  test('j/k move, h/l fold and open, y copies the path, d opens the detail', async ($, on) => {
    harness(on)
    const h = host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    const selectedKey = async () => {
      return (await clientLines(ui)).find((l) => l.id && l.segs.some((x) => x.bg === DARK.colors.selection))?.id
    }
    await ui.press({ key: 'key:j' })
    expect(await selectedKey()).toBe(`d:${CWD}/.claude`)
    await ui.press({ key: 'key:j' })
    expect(await selectedKey()).toBe(`d:${CWD}/sub`)
    await ui.press({ key: 'key:l' })
    expect(await rowNode(ui, `f:${SUB_A_PATH}`)).toBeDefined()
    await ui.press({ key: 'key:j' })
    expect(await selectedKey()).toBe(`f:${SUB_A_PATH}`)
    await ui.press({ key: 'key:y' })
    expect(h.copies).toEqual([SUB_A_PATH])
    await ui.press({ key: 'key:h' })
    expect(await selectedKey()).toBe(`d:${CWD}/sub`)
    await ui.press({ key: 'key:h' })
    expect(await rowNode(ui, `f:${SUB_A_PATH}`)).toBeUndefined()
    await ui.press({ key: 'key:k' })
    expect(await selectedKey()).toBe(`d:${CWD}/.claude`)
  })
})

describe('help key', () => {
  const setup = async ($: Engine, on: On) => {
    const fv = harness(on)
    const h = host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await fv.clock.advance(MIN_TAG_MS)
    await runFiles($, true, 160)
    const ui = await $.ui.mount(pane(60, 60))
    h.opened.length = 0
    return { ui, h }
  }
  const isHelp = async (ui: { drawn: () => Promise<unknown> }) => {
    const text = (await screen(ui)).join('\n')
    return text.includes('g  help (this view)') && text.includes('●  read in full')
  }

  // `g` is a hidden hotkey (no `g: help` text is drawn); the help view draws no key row.
  test('`g` (a hidden hotkey) opens the help view (every key and glyph); d closes it back to the list', async ($, on) => {
    const { ui } = await setup($, on)
    expect(await ui.find({ key: 'key:g' })).toMatchObject({ props: { hotkey: 'g' } })
    expect((await screen(ui)).join('\n')).not.toContain('g: help')
    await ui.press({ key: 'key:g' })
    expect(await isHelp(ui)).toBe(true)
    expect((await screen(ui)).join('\n')).not.toMatch(/(^| )[a-z]: /m)
    await ui.press({ key: 'key:d' })
    expect(await isHelp(ui)).toBe(false)
    expect(await rowNode(ui, `f:${BIG_PATH}`)).toBeDefined()
  })

  test('`g` works while the rows Client holds the keys (after a click on the list)', async ($, on) => {
    const { ui } = await setup($, on)
    // A click on the fold row (it opens; no detail view) gives the rows Client the keys.
    await clickRow(ui, `u:${CWD}`)
    await ui.key({ key: 'g', in: 'rows' } as never)
    expect(await isHelp(ui)).toBe(true)
  })
})

describe('closing the detail hands the keyboard to the prompt', () => {
  // 2.1.295 has no call that gives the keys back; a pane re-opened without `focus` opens without them, so
  // closing the detail closes the pane and opens it again unfocused: the next keystroke reaches the prompt.
  const setup = async ($: Engine, on: On) => {
    harness(on)
    const h = host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await runFiles($, true, 160)
    const ui = await $.ui.mount(pane(60, 16))
    await clickRow(ui, `f:${BIG_PATH}`)
    expect((await screen(ui)).join('\n')).toContain('1–200 / 1,323')
    h.opened.length = 0
    return { ui, h }
  }
  const handedBack = (h: ReturnType<typeof host>) => {
    expect(h.closed).toEqual([expect.objectContaining({ id: 'ccfiles' })])
    expect(h.opened).toEqual([expect.objectContaining({ id: 'ccfiles', title: 'ccfiles' })])
    expect((h.opened[0] as { focus?: unknown }).focus).toBeUndefined()
  }

  test('d from the key row', async ($, on) => {
    const { ui, h } = await setup($, on)
    await ui.press({ key: 'key:d' })
    handedBack(h)
    expect(await rowNode(ui, `f:${BIG_PATH}`)).toBeDefined()
  })

  for (const key of ['d', 'q']) {
    test(`${key} while the rows Client holds the keys (after a click)`, async ($, on) => {
      const { ui, h } = await setup($, on)
      await ui.key({ key, in: 'rows' } as never)
      handedBack(h)
      expect(await rowNode(ui, `f:${BIG_PATH}`)).toBeDefined()
    })
  }

  test('q from the key row', async ($, on) => {
    const { ui, h } = await setup($, on)
    await ui.press({ key: 'key:q' })
    handedBack(h)
  })

  // One redraw frame is allowed on close, but the list must not jump or lose its scroll position.
  const MANY = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`${CWD}/many/f${String(i).padStart(2, '0')}.ts`, 'x\n']))
  const close: [string, 'd' | 'q', 'key row' | 'rows Client'][] = [
    ['d from the key row', 'd', 'key row'],
    ['q from the key row', 'q', 'key row'],
    ['d in the rows Client', 'd', 'rows Client'],
    ['q in the rows Client', 'q', 'rows Client'],
  ]
  for (const [how, key, where] of close) {
    test(`${how}: the first frame after reopening keeps the top row and the selection, also narrower`, async ($, on) => {
      const fv = harness(on, { ...FILES, ...MANY })
      const h = host(on)
      const t = tools(on)
      await startSession($)
      // Touched files, so each has a detail view; then the lit rows fade.
      for (const path of Object.keys(MANY)) await t.call($, { tool: 'Read', file_path: path }, readResult(path, 'x\n'))
      await fv.clock.advance(10_000)
      await runFiles($, true, 160)
      const ui = await $.ui.mount(pane(60, 12))
      // The selected name is underlined (its fill hides the selection background on a fully read row).
      const selected = async (u: typeof ui) => (await clientLines(u)).find((l) => l.id && l.segs.some((x) => x.u))?.id
      const top = async (u: typeof ui) => (await clientLines(u)).find((l) => l.id)?.id
      // Follow opened many/ on the reads. Move down from the top: the window scrolls past the first page.
      await ui.press({ key: 'key:f' })
      for (let i = 0; i < 30; i++) await ui.press({ key: 'key:j' })
      const before = { top: await top(ui), selected: await selected(ui) }
      expect(before.selected).toMatch(/many\/f\d\d\.ts$/)
      expect(before.top).not.toBe(`d:${CWD}/.claude`)
      expect(Number(before.selected!.slice(-5, -3))).toBeGreaterThan(15)
      // From the key row, d opens it; with the rows Client holding the keys, a click on the selected row does.
      if (where === 'key row') await ui.press({ key: 'key:d' })
      else await clickRow(ui, before.selected!)
      // The detail view is open (no `d: close` key row; its history section shows instead).
      expect((await screen(ui)).join('\n')).toMatch(/^history/m)
      h.opened.length = 0
      if (where === 'key row') await ui.press({ key: `key:${key}` })
      else await ui.key({ key, in: 'rows' } as never)
      expect(h.opened).toHaveLength(1)
      // The re-opened pane's first frame: same window, same selection.
      await ui.unmount()
      const again = await $.ui.mount(pane(60, 12))
      expect({ top: await top(again), selected: await selected(again) }).toEqual(before)
      await again.unmount()
      const narrow = await $.ui.mount(pane(39, 12))
      expect({ top: await top(narrow), selected: await selected(narrow) }).toEqual(before)
    })
  }

  test('opening the detail and moving in the list keep the keys in the pane', async ($, on) => {
    harness(on)
    const h = host(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    await ui.press({ key: 'key:j' })
    await clickRow(ui, `f:${SMALL_PATH}`)
    expect(h.closed).toEqual([])
  })
})

// No key legend row at any width;
// every key is a hidden hotkey Button in a zero-width Box; the header buttons, tab strip and branch row stay one line
// within the width.
describe('narrow panels: no key legend; header, tabs and branch row fit', () => {
  // Panel widths: 89 (220-column tmux), 71 (170), 59 (125); 39 is the panel at 110 terminal columns,
  // the narrowest the panel opens at.
  const WIDTHS = [89, 71, 59, 52, 42, 40, 39]
  const STATUS = Array.from({ length: 202 }, (_, i) => `?? n${i}.ts`).join('\0') + '\0'
  const repo = (on: On) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('process.run', (_$, e) => {
      const argv = e.argv.join(' ')
      const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
      if (argv.startsWith('git status')) return ok(STATUS)
      if (argv === 'git branch --show-current') return ok('main\n')
      if (argv === 'git rev-parse HEAD') return ok('a'.repeat(40) + '\n')
      return ok('')
    })
  }
  const LIST_KEYS = ['j', 'k', 'h', 'l', 'd', 's', 'g', 'f', 'y', 'o', 'c', 'a', 'u', '1', '2', '3']
  const DETAIL_KEYS = ['d', 'j', 'k', 'y', 'q', '1', '2', '3']
  const rowsOf = async (ui: { drawn: () => Promise<unknown> }) => ((await ui.drawn()) as Node).children!.map((c) => c as Node)
  const keyOf = (n: Node) => String(n.key ?? n.props?.key ?? '')
  /** The hidden hotkeys: Buttons inside the zero-width `keys` Box. */
  const hidden = async (ui: { drawn: () => Promise<unknown> }) => {
    const find = (n: Node): Node | undefined => (keyOf(n) === 'keys' ? n : (n.children ?? []).map((c) => (c && typeof c === 'object' ? find(c as Node) : undefined)).find(Boolean))
    const box = find((await ui.drawn()) as Node)!
    expect(box.props).toMatchObject({ width: 0, overflow: 'hidden' })
    return (box.children ?? []).map((c) => (c as Node).props?.hotkey as string)
  }

  for (const w of WIDTHS) {
    test(`${w} columns: list (with a filter on Touched) and detail draw no key legend; every line fits; the keys stay`, async ($, on) => {
      const h = harness(on)
      host(on)
      repo(on)
      const t = tools(on)
      await startSession($)
      await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
      const ui = await $.ui.mount(pane(w, 20))
      await $.prompt.submit({ text: 'hi', wait: false } as never)
      await h.clock.settle()
      await ui.redraw()
      const check = async (what: string, keys: readonly string[]) => {
        const rows = await rowsOf(ui)
        // No legend row among the pane's rows, and no `x: label` text anywhere.
        expect(rows.filter((r) => keyOf(r).startsWith('keys'))).toEqual([])
        for (const line of await screen(ui)) {
          if (cellWidth(line) > w) throw new Error(`${what} at ${w}: ${cellWidth(line)} cells: ${line}`)
          expect(line).not.toMatch(/(^| )[a-z0-9]: /)
        }
        // The keys still work with no click: hidden hotkeys.
        const hot = await hidden(ui)
        for (const k of keys) expect(hot).toContain(k)
        // Header: the root name and the one-glyph buttons on one line at every width.
        const head = rows.find((r) => keyOf(r) === 'head')!
        expect(head.props?.height).toBe(1)
        for (const b of ['help', 'refresh', 'follow', 'column', 'collapse']) expect(await ui.find({ key: `btn:${b}` })).toBeDefined()
        // Tab strip: one line within the width.
        const tabs = rows.find((r) => keyOf(r) === 'tabs')!
        if (cellWidth(textOf(tabs)) > w) throw new Error(`${what} at ${w}: tabs ${cellWidth(textOf(tabs))} cells: ${textOf(tabs)}`)
        expect(textOf(tabs)).toMatch(/Touched 1/)
      }
      await check('tree', LIST_KEYS)
      // The branch row counts the 202 untracked files in words, never `?`.
      const branch = (await screen(ui)).find((l) => l.startsWith('⎇'))!
      expect(branch).toMatch(/^⎇  main\b/)
      if (w >= 52) expect(branch).toContain('202 new')
      expect(branch).not.toContain('?')
      await ui.press({ key: 'tab:touched' })
      await check('touched', LIST_KEYS)
      await ui.input({ key: 'search', text: 'small' })
      await check('touched + filter', LIST_KEYS)
      await clickRow(ui, `f:${SMALL_PATH}`)
      await check('detail', DETAIL_KEYS)
    })
  }
})

describe('selection as context', () => {
  test('with selectionContext on, a selected file adds exactly one line to the prompt', { options: { selectionContext: true } }, async ($, on) => {
    harness(on)
    host(on)
    on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
    await startSession($)
    const before = await $.prompt.submit({ text: 'explain', wait: false } as never)
    expect(before.context).toBe(undefined)
    const ui = await $.ui.mount(pane(60, 16))
    await clickRow(ui, `f:${SMALL_PATH}`)
    const r = await $.prompt.submit({ text: 'explain this', wait: false } as never)
    expect(r.context).toEqual(['The user has small.ts selected in the ccfiles panel; "this file" or "this" may refer to it.'])
  })

  test('off by default: a selected file adds nothing', async ($, on) => {
    harness(on)
    host(on)
    on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
    await startSession($)
    const ui = await $.ui.mount(pane(60, 16))
    await clickRow(ui, `f:${SMALL_PATH}`)
    const r = await $.prompt.submit({ text: 'explain this', wait: false } as never)
    expect(r.context).toBe(undefined)
  })
})
