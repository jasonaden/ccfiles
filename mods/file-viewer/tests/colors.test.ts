// Palette values, contrast with receding keys, no painted background in dark, names coloured by git state, and no
// trailing `/` on folders.
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { GitFile, GitSnapshot, NumStat } from '../src/git.ts'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import {
  COLOR_KEYS,
  RECEDING,
  contrastRatio,
  defaultPalette,
  dimFillBackground,
  fillBackground,
  hue,
  quantize256,
  readableOn,
  type ColorDepth,
  type ColorKey,
  type FillTone,
  type Palette,
  type Variant,
} from '../src/palette.ts'
import { replay } from '../src/reducer.ts'
import { rowLine, rowSegments } from '../src/view/draw.ts'
import { rowsFor, touchedRows, treeRows, type Row, type ViewContext } from '../src/view/rows.ts'
import type { RowsProps } from '../hooks/rows.ts'
import { BIG, CWD, SMALL, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clickRow, clientLines, lineText } from './rows-client.ts'

const AVOIDED_HUES = { purple: '#a855f7', orange: '#f97316', green: '#22c55e' }
const VARIANTS: Variant[] = ['dark', 'light']
const DEPTHS: ColorDepth[] = ['truecolor', '256']
const TONES: FillTone[] = ['read', 'edit', 'commit']
/** Every colour drawn as a foreground: names, meta, glyphs. */
const FG: ColorKey[] = COLOR_KEYS.filter((k) => k !== 'selection' && !k.startsWith('fill'))
const receding = (k: ColorKey) => RECEDING.includes(k)
const cell = (hex: string) => quantize256(hex).hex
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360))

describe('dark palette values', () => {
  // [key, 256-colour (cube-safe) value, truecolor value].
  const TABLE: [ColorKey, string, string][] = [
    ['text', '#d4d6dc', '#dcdfe4'],
    ['muted', '#a6a8b0', '#7f8794'],
    ['accent', '#9fc0d8', '#6fa8dc'],
    ['read', '#8fb1d3', '#7cc0e8'],
    ['search', '#8fb8b8', '#8fcfc4'],
    ['edit', '#db9aad', '#ec8fab'],
    ['commit', '#c4c27c', '#d6cd62'],
    ['instruction', '#aea8d4', '#b3a6ec'],
    ['git.M', '#cdb57f', '#dcb862'],
    ['git.A', '#93bf9a', '#8cc085'],
    ['added', '#93bf9a', '#8cc085'],
    ['git.D', '#e09a9a', '#e0787f'],
    ['removed', '#e09a9a', '#e0787f'],
    ['git.R', '#8fb3d9', '#6cb0e0'],
    ['selection', '#3a3a3a', '#3b4252'],
  ]

  test('with no config, dark truecolor equals the truecolor column (git.untracked joins git.A)', () => {
    const p = defaultPalette('dark', 'truecolor')
    for (const [key, , truecolor] of TABLE) expect([key, p.colors[key]]).toEqual([key, truecolor])
    expect(p.colors['git.untracked']).toBe('#8cc085')
  })

  test('256 colours keep the cube-safe values', () => {
    const p = defaultPalette('dark', '256')
    for (const [key, cube] of TABLE) expect([key, p.colors[key]]).toEqual([key, cube])
    // No colour (NO_COLOR) draws the same set as 256.
    expect(defaultPalette('dark', 'none').colors).toEqual(p.colors)
  })

  // The commit gold (`#d6cd62`, light `#6f6800`) is ≥ 30° from the orange.
  const BELOW_30 = new Set<string>()
  for (const variant of VARIANTS) {
    for (const depth of DEPTHS) {
      test(`${variant} ${depth}: read, edit and commit stay ≥ 30° from the avoided purple, orange and green`, () => {
        const p = defaultPalette(variant, depth)
        for (const key of ['read', 'edit', 'commit'] as const) {
          for (const [name, hex] of Object.entries(AVOIDED_HUES)) {
            const d = hueDistance(hue(p.colors[key]), hue(hex))
            const pair = `${variant} ${depth} ${key} ${name}`
            const min = BELOW_30.has(pair) ? 15 : 30
            if (d < min) throw new Error(`${pair}: ${p.colors[key]} is ${d.toFixed(1)}° from ${hex}`)
          }
        }
      })
    }
  }
})

describe('contrast with receding keys', () => {
  const REFERENCE_DARK = ['#000000', '#1e1e1e', '#262626']

  /** `fg` on `bg` as drawn: the exact colours in truecolor, and the xterm cells too in 256 colours. */
  const ratios = (fg: string, bg: string, depth: ColorDepth) => (depth === 'truecolor' ? [contrastRatio(fg, bg)] : [contrastRatio(fg, bg), contrastRatio(cell(fg), cell(bg))])

  for (const depth of DEPTHS) {
    test(`dark ${depth}: every name and meta colour reaches 4.5:1 on #000000, #1e1e1e and #262626; muted and git.ignored 3:1`, () => {
      const p = defaultPalette('dark', depth)
      for (const bg of REFERENCE_DARK) {
        for (const key of FG) {
          const min = receding(key) ? 3 : 4.5
          for (const r of ratios(p.colors[key], bg, depth)) {
            if (r < min) throw new Error(`dark ${depth} ${key} ${p.colors[key]} on ${bg}: ${r.toFixed(2)} < ${min}`)
          }
        }
      }
    })
  }

  for (const variant of VARIANTS) {
    for (const depth of DEPTHS) {
      test(`${variant} ${depth}: readableOn the selection gives 4.5:1 for every key, receding ones included`, () => {
        const p = defaultPalette(variant, depth)
        for (const key of FG) {
          const fg = readableOn(p.colors[key], p.colors.selection, p)
          for (const r of ratios(fg, p.colors.selection, depth)) {
            if (r < 4.5) throw new Error(`${variant} ${depth} ${key} → ${fg} on ${p.colors.selection}: ${r.toFixed(2)}`)
          }
        }
      })
    }
  }

  test('light truecolor: 4.5:1 on its painted white, receding keys 3:1', () => {
    const p = defaultPalette('light', 'truecolor')
    expect(p.background).toBe('#ffffff')
    for (const key of FG) {
      const r = contrastRatio(p.colors[key], p.background)
      const min = receding(key) ? 3 : 4.5
      if (r < min) throw new Error(`light ${key} ${p.colors[key]}: ${r.toFixed(2)} < ${min}`)
      // readableOn keeps it as is on the painted background: no swap needed.
      expect(readableOn(p.colors[key], p.background, p, min)).toBe(p.colors[key])
    }
  })

  // Through the row renderer: what a person sees.
  const T = 1_000_000
  const ROOT = '/p'
  const untouched = (): Row => treeRows({ state: replay([]), root: ROOT, home: null, projectFiles: [`${ROOT}/u.ts`], git: null, pending: new Map(), now: T }, { expanded: new Set(), query: '', sort: 'recent' }).find((r) => r.path === `${ROOT}/u.ts`)!
  const nameOf = (segs: ReturnType<typeof rowSegments>) => segs.find((s) => s.name)!

  for (const variant of VARIANTS) {
    for (const depth of DEPTHS) {
      test(`${variant} ${depth}: an untouched row recedes in muted (not swapped for text); selected, its name reaches 4.5:1 on the selection`, () => {
        const p = defaultPalette(variant, depth)
        const row = untouched()
        expect(row.tone).toBe('muted')
        expect(nameOf(rowSegments(row, 60, p, false)).fg).toBe(p.colors.muted)
        const sel = nameOf(rowSegments(row, 60, p, true))
        for (const r of ratios(sel.fg!, p.colors.selection, depth)) expect(r).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

// ---- no painted background in dark -------------------------------------------

type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

/** Every backgroundColor in a drawn tree, with where it sits; a Client's own props are listed, not walked. */
function backgrounds(n: unknown, where = 'root', out: { bg: string; where: string }[] = []): { bg: string; where: string }[] {
  if (n === null || typeof n !== 'object') return out
  const node = n as Node
  const key = String(node.key ?? node.props?.key ?? where)
  const bg = node.props?.backgroundColor
  if (typeof bg === 'string') out.push({ bg, where: `${node.type} ${key}` })
  if (node.type === 'Client') {
    const props = node.props?.props as RowsProps
    if (props.bg) out.push({ bg: props.bg, where: 'Client props.bg' })
    for (const l of props.lines) for (const s of l.segs) if (s.bg) out.push({ bg: s.bg, where: `rows ${l.id || '(line)'} “${s.t}”` })
    return out
  }
  for (const c of node.children ?? []) backgrounds(c, key, out)
  return out
}

describe('no painted background in dark', () => {
  const BIG_PATH = `${CWD}/big.md`
  const ENV: Record<ColorDepth, Record<string, string>> = { truecolor: { COLORTERM: 'truecolor', TERM: 'xterm-256color' }, '256': { TERM: 'xterm-256color' }, none: {} }

  for (const variant of VARIANTS) {
    for (const depth of DEPTHS) {
      // The row fill is drawn only with `coverage: fill`; on here so the fill check is not vacuous.
      test(`${variant} ${depth}: header, rows and footer carry ${variant === 'dark' ? 'no background but the selection, hover, band and fills' : 'the painted light background'}`, { options: { coverage: 'fill' } }, async ($, on) => {
        harness(on)
        host(on, variant)
        mock.env(on, ENV[depth])
        const t = tools(on)
        await startSession($)
        await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
        const ui = await $.ui.mount(pane(60, 16))
        // A selected row (a click on the fold row selects it) and a hovered one.
        await clickRow(ui, `u:${CWD}`)
        const lines = await clientLines(ui)
        const y = lines.findIndex((l) => l.id === `f:${BIG_PATH}`)
        await ui.pointer({ type: 'move', x: 5, y, in: 'rows' } as never)
        const p: Palette = defaultPalette(variant, depth)
        const pane_ = (await ui.drawn()) as Node
        const client = (await ui.drawn({ in: 'rows' } as never)) as Node
        const found = [...backgrounds(pane_), ...backgrounds(client, 'client')]
        const props = (function find(n: unknown): RowsProps | undefined {
          const node = n as Node
          if (node?.type === 'Client') return node.props?.props as RowsProps
          for (const c of node?.children ?? []) {
            const hit = find(c)
            if (hit) return hit
          }
          return undefined
        })(pane_)!
        if (variant === 'dark') {
          expect(pane_.props?.backgroundColor).toBeUndefined()
          expect(props.bg).toBeUndefined()
          const allowed = new Set([
            p.colors.selection,
            props.hoverBg,
            ...Object.values(props.bands).flatMap((b) => b.map((x) => x.bg)),
            ...TONES.flatMap((t) => [fillBackground(p, t), dimFillBackground(p, t)]),
          ])
          // The fixture draws the fill, the selection and the hover, so the check is not vacuous.
          expect(found.some((f) => f.bg === fillBackground(p, 'read'))).toBe(true)
          expect(found.some((f) => f.bg === p.colors.selection)).toBe(true)
          expect(found.some((f) => f.bg === props.hoverBg)).toBe(true)
          for (const f of found) if (!allowed.has(f.bg)) throw new Error(`dark ${depth}: ${f.where} paints ${f.bg}`)
          expect(found.some((f) => f.bg === p.background)).toBe(false)
        } else {
          expect(pane_.props?.backgroundColor).toBe(p.background)
          expect(props.bg).toBe(p.background)
        }
      })
    }
  }
})

// ---- name colour follows git state -------------------------------------------

describe('name colour follows git state', () => {
  const ROOT = '/p'
  const T = 1_000_000
  const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })
  const gitFile = (name: string, letter: GitFile['letter']): GitFile & NumStat => ({ path: `${ROOT}/${name}`, letter, staged: false, added: 0, removed: 0, binary: false })
  const CHANGED: [string, GitFile['letter'], ColorKey][] = [
    ['modified.ts', 'M', 'git.M'],
    ['added.ts', 'A', 'git.A'],
    ['untracked.ts', '?', 'git.A'],
    ['deleted.ts', 'D', 'git.D'],
    ['renamed.ts', 'R', 'git.R'],
    ['ignored.log', '!', 'git.ignored'],
  ]
  const git: GitSnapshot = { root: ROOT, branch: 'main', head: 'abc', ahead: 0, behind: 0, files: new Map(CHANGED.map(([n, l]) => [`${ROOT}/${n}`, gitFile(n, l)])) }
  const all = [...CHANGED.map(([n]) => n), 'clean.ts', 'quiet.ts']
  // A one-line read of a long file: touched, with no fill under the name.
  const read = (name: string) => ev({ kind: 'read', path: `${ROOT}/${name}`, ranges: [[1, 1]], totalLines: 1000 })
  const ctx = (records: LogRecord[]): ViewContext => ({ state: replay(records), root: ROOT, home: null, projectFiles: all.map((n) => `${ROOT}/${n}`), git, pending: new Map(), now: T })
  // Every file touched but quiet.ts: changed files, then clean.ts (touched, no git change).
  const touched = ctx(all.filter((n) => n !== 'quiet.ts').map(read))
  const EXPECTED: [string, ColorKey][] = [...CHANGED.map(([n, , k]) => [n, k] as [string, ColorKey]), ['clean.ts', 'text']]
  const tabs: [string, () => Row[]][] = [
    ['Tree', () => treeRows(touched, { expanded: new Set([`u:${ROOT}`]), query: '', sort: 'recent' })],
    ['Touched', () => touchedRows(touched, { expanded: new Set(), query: '', sort: 'recent' })],
  ]

  for (const [tab, rows] of tabs) {
    test(`${tab}: modified, added/untracked, deleted, renamed, ignored take their git colour; touched and clean is text`, () => {
      const rs = rows()
      for (const [name, key] of EXPECTED) expect([name, rs.find((r) => r.path === `${ROOT}/${name}`)?.tone]).toEqual([name, key])
    })

    for (const variant of VARIANTS) {
      for (const depth of DEPTHS) {
        test(`${tab} ${variant} ${depth}: the drawn name is that colour; only the deleted one is struck through`, () => {
          const p = defaultPalette(variant, depth)
          const rs = rows()
          for (const [name, key] of EXPECTED) {
            const row = rs.find((r) => r.path === `${ROOT}/${name}`)!
            const segs = rowSegments(row, 60, p, false)
            const nameSeg = segs.find((s) => s.name)!
            expect([name, nameSeg.fg]).toEqual([name, p.colors[key]])
            expect([name, nameSeg.strike === true]).toEqual([name, name === 'deleted.ts'])
            // The rows Client gets the strikethrough too.
            const line = rowLine(row, 60, p, false)
            expect([name, line.segs.some((s) => s.s === true)]).toEqual([name, name === 'deleted.ts'])
          }
        })
      }
    }
  }

  test('Tree: an untouched clean file is muted; an untouched changed one still takes its git colour', () => {
    const rs = treeRows(ctx([]), { expanded: new Set([`u:${ROOT}`]), query: '', sort: 'recent' })
    expect(rs.find((r) => r.path === `${ROOT}/quiet.ts`)?.tone).toBe('muted')
    expect(rs.find((r) => r.path === `${ROOT}/modified.ts`)?.tone).toBe('git.M')
  })

  test('the rows Client draws a deleted file’s name with strikethrough', async ($, on) => {
    harness(on)
    host(on)
    gitStub(on, ' D small.ts\0 M big.md\0', '0\t40\tsmall.ts\n1\t1\tbig.md\n')
    const t = tools(on)
    await startSession($)
    const SMALL_PATH = `${CWD}/small.ts`
    const BIG_PATH = `${CWD}/big.md`
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 1 }, readResult(BIG_PATH, BIG, 1, 1))
    const ui = await $.ui.mount(pane(70, 20))
    await $.prompt.submit({ text: 'hi', wait: false } as never)
    await ui.redraw()
    const lines = await clientLines(ui)
    const drawn = ((await ui.drawn({ in: 'rows' } as never)) as Node).children as Node[]
    const struck = (id: string) => {
      const y = lines.findIndex((l) => l.id === id)
      expect(y).toBeGreaterThanOrEqual(0)
      return ((drawn[y]!.children ?? []) as Node[]).filter((x) => x.props?.strikethrough === true).map((x) => (x.children as string[]).join(''))
    }
    expect(struck(`f:${SMALL_PATH}`).join('')).toContain('small.ts')
    expect(struck(`f:${BIG_PATH}`)).toEqual([])
  })
})

/** Answers the read-only git commands the mod runs (as tests/git-panel.test.ts does). */
function gitStub(on: On, status: string, numstat: string) {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
    if (argv.startsWith('git status')) return ok(status)
    if (argv.startsWith('git diff --numstat')) return ok(numstat)
    if (argv.startsWith('git rev-list')) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: no upstream', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv === 'git branch --show-current') return ok('main\n')
    if (argv === 'git rev-parse HEAD') return ok(`${'a'.repeat(40)}\n`)
    if (argv.startsWith('git diff --name-only')) return ok('')
    return { deny: `unexpected: ${argv}` }
  })
}

// ---- folder names ------------------------------------------------------------

describe('folder names have no trailing /', () => {
  const ROOT = '/p'
  const T = 1_000_000
  const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })
  const rule = `${ROOT}/.claude/rules/r.md`
  const records: LogRecord[] = [
    ev({ kind: 'read', path: `${ROOT}/src/view/a.ts`, ranges: [[1, 2]], totalLines: 2 }),
    ev({ kind: 'autoload', path: rule, source: 'attachment', whole: true, totalLines: 4, estTokens: 9, origin: 'project', loadReason: 'path_glob_match' }),
  ]
  const c: ViewContext = { state: replay(records), root: ROOT, home: null, projectFiles: [`${ROOT}/src/view/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/docs/x.md`, rule], git: null, pending: new Map(), now: T }
  const ui = { expanded: new Set([`${ROOT}/src`, `${ROOT}/src/view`, `${ROOT}/.claude`, `${ROOT}/.claude/rules`, `u:${ROOT}`, `u:${ROOT}/src`]), query: '', sort: 'recent' as const }

  test('Tree, Touched and Instructions: no row label ends with /', () => {
    const tree = rowsFor('tree', c, ui)
    // Folders are drawn (open, closed and folded), so the check covers them.
    expect(tree.filter((r) => r.kind === 'dir').map((r) => r.label)).toEqual(expect.arrayContaining(['src', 'view', '.claude', 'rules', 'docs']))
    for (const tab of ['tree', 'touched', 'instructions'] as const) {
      for (const r of rowsFor(tab, c, ui)) expect([tab, r.label, r.label.endsWith('/')]).toEqual([tab, r.label, false])
    }
  })

  test('the drawn panel: no word ends in / in any tab or the detail view', async ($, on) => {
    harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    const A = `${CWD}/sub/a.ts`
    await t.call($, { tool: 'Read', file_path: A }, readResult(A, '// a\n'))
    const ui = await $.ui.mount(pane(60, 20))
    const noSlash = async (where: string) => {
      const text = await screen(ui)
      for (const l of text) if (/\S\/(\s|$)/.test(l)) throw new Error(`${where}: “${l.trimEnd()}”`)
      return text
    }
    expect((await noSlash('tree')).some((l) => /\bsub\b/.test(l))).toBe(true)
    await ui.press({ key: 'tab:touched' })
    await noSlash('touched')
    await ui.press({ key: 'tab:instructions' })
    await noSlash('instructions')
    await ui.press({ key: 'tab:tree' })
    await clickRow(ui, `f:${A}`)
    const detail = (await clientLines(ui)).map(lineText)
    expect(detail.join('\n')).toContain('sub/a.ts')
    await noSlash('detail')
  })
})
