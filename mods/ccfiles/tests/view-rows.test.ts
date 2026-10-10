import { describe, expect, test } from 'claude-code/testing'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { RECEDING, buildPalette, contrastRatio, defaultPalette, deltaE, fillBackground, hue, parseConfig, quantize256, type Variant } from '../src/palette.ts'
import { rowSegments } from '../src/view/draw.ts'
import { focusTarget, initialPanel, listWindow, openDetail } from '../src/view/panel.ts'
import { LIT_MS, instructionRows, rowsFor, touchedRows, treeRows, type Row, type ViewContext } from '../src/view/rows.ts'
import { cellWidth } from '../src/view/text.ts'

const ROOT = '/p'
const T = 1_000_000
const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })

function ctx(records: LogRecord[], extra: Partial<ViewContext> = {}): ViewContext {
  return { state: replay(records), root: ROOT, home: '/home/u', projectFiles: [`${ROOT}/untouched.ts`], git: null, pending: new Map(), now: T, ...extra }
}

const ui = { expanded: new Set<string>(), query: '', sort: 'recent' as const }
/** Everything a row shows besides color: its glyph and its meta labels. */
const marks = (r: Row) => [r.glyph?.text ?? '', ...r.meta.map((m) => m.text)].join(' ')

describe('state is never color alone', () => {
  test('each coverage and action state has its own glyph or label', () => {
    const records: LogRecord[] = [
      ev({ kind: 'read', path: `${ROOT}/full.ts`, ranges: [[1, 10]], totalLines: 10 }),
      ev({ kind: 'read', path: `${ROOT}/partial.ts`, ranges: [[1, 5]], totalLines: 10 }),
      ev({ kind: 'read', path: `${ROOT}/unknown.ts`, unknownRange: true, totalLines: 10 }),
      ev({ kind: 'hit', path: `${ROOT}/hit.ts` }),
      ev({ kind: 'listing', path: `${ROOT}/listed.ts` }),
      ev({ kind: 'edit', path: `${ROOT}/edited.ts`, tool: 'Edit', linesAdded: 1 }),
      ev({ kind: 'autoload', path: `${ROOT}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 }),
      ev({ kind: 'read', path: `${ROOT}/again.ts`, ranges: [[1, 5]], totalLines: 10 }),
      ev({ kind: 'read', path: `${ROOT}/again.ts`, ranges: [[1, 5]], totalLines: 10 }),
      ev({ kind: 'hit', path: `${ROOT}/guess.ts`, verified: false }),
      ev({ kind: 'read', path: `${ROOT}/lit.ts`, ranges: [[1, 2]], totalLines: 10, ts: T - 100 }),
      ev({ kind: 'read', path: `${ROOT}/denied.ts`, outcome: 'denied' }),
    ]
    const rows = touchedRows(ctx(records, { pending: new Map([[`${ROOT}/pending.ts`, 'read']]) }), ui)
    const by = (name: string) => marks(rows.find((r) => r.path === `${ROOT}/${name}`)!)
    expect(by('full.ts')).toMatch(/^●/)
    expect(by('partial.ts')).toMatch(/^◐/)
    expect(by('unknown.ts')).toMatch(/^◐/)
    expect(by('hit.ts')).toMatch(/^◇/)
    expect(by('listed.ts')).toMatch(/^·/)
    expect(by('edited.ts')).toMatch(/^✎/)
    expect(by('CLAUDE.md')).toContain('⚡')
    expect(by('again.ts')).toContain('↩1')
    expect(by('guess.ts')).toContain('?')
    expect(by('lit.ts')).toContain(' read ')
    expect(by('pending.ts')).toContain('reading')
    // A denied call lights nothing and adds no coverage glyph.
    expect(rows.find((r) => r.path === `${ROOT}/denied.ts`)).toBe(undefined)
    // An unknown-range read is partly read (◐) too; the other states each have their own glyph.
    const glyphs = ['full.ts', 'partial.ts', 'hit.ts', 'listed.ts', 'edited.ts'].map((n) => by(n)[0])
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  test('a file a compaction dropped shows ⊘ in its row; a re-injected one shows ⟳ and no ⊘', () => {
    const records: LogRecord[] = [
      ev({ kind: 'read', path: `${ROOT}/dropped.md`, ranges: [[150, 200]], totalLines: 1323, estTokens: 500 }),
      ev({ kind: 'read', path: `${ROOT}/kept.ts`, ranges: [[1, 10]], totalLines: 10, estTokens: 50 }),
      ev({ kind: 'compact', path: '', source: 'session' }),
      ev({ kind: 'read', path: `${ROOT}/kept.ts`, tool: 'n/a', source: 'compactRestore', ranges: [[1, 10]], estTokens: 60 }),
    ]
    const rows = touchedRows(ctx(records), ui)
    const by = (name: string) => marks(rows.find((r) => r.path === `${ROOT}/${name}`)!)
    expect(by('dropped.md')).toContain('⊘')
    expect(by('kept.ts')).toContain('⟳')
    expect(by('kept.ts')).not.toContain('⊘')
  })

  test('capped (MEMORY.md) has its own glyph; untouched project files have none and are muted', () => {
    const mem = '/home/u/.claude/projects/-p/memory/MEMORY.md'
    const c = ctx([ev({ kind: 'autoload', path: mem, source: 'promptContext', ranges: [[1, 200]], totalLines: 260, capped: true, origin: 'memory', estTokens: 2000 })])
    const memRow = instructionRows(c, ui).find((r) => r.path === mem)!
    expect(memRow.label).toBe('MEMORY.md (auto memory)')
    // In the Instructions tab `⚡` sits once on the Auto-loaded header, not on its rows.
    expect(marks(memRow)).not.toContain('⚡')
    expect(memRow.glyph?.text).toBe('◐')
    expect(touchedRows(c, ui).find((r) => r.path === mem)!.glyph?.text).toBe('◐')
    const untouched = treeRows(c, ui).find((r) => r.path === `${ROOT}/untouched.ts`)!
    expect(untouched).toMatchObject({ glyph: null, tone: 'muted', meta: [] })
  })

  test(`a lit row fades after ${LIT_MS} ms`, () => {
    const records = [ev({ kind: 'read', path: `${ROOT}/a.ts`, ranges: [[1, 2]], totalLines: 10, ts: T })]
    expect(touchedRows(ctx(records, { now: T + 100 }), ui)[0]!.lit).toBe('read')
    expect(touchedRows(ctx(records, { now: T + LIT_MS + 1 }), ui)[0]!.lit).toBe(null)
  })
})

describe('out-of-context rows are dimmed', () => {
  const dropped = `${ROOT}/dropped.md`
  const rule = `${ROOT}/.claude/rules/r.md`
  const base: LogRecord[] = [
    ev({ kind: 'read', path: dropped, ranges: [[1, 600]], totalLines: 1200, estTokens: 500 }),
    ev({ kind: 'read', path: `${ROOT}/kept.ts`, ranges: [[1, 10]], totalLines: 10, estTokens: 50 }),
    ev({ kind: 'autoload', path: rule, source: 'attachment', whole: true, totalLines: 4, estTokens: 9, origin: 'project', loadReason: 'path_glob_match' }),
    ev({ kind: 'compact', path: '', source: 'session' }),
    ev({ kind: 'read', path: `${ROOT}/kept.ts`, tool: 'n/a', source: 'compactRestore', ranges: [[1, 10]], estTokens: 60 }),
  ]
  const expanded = new Set([`${ROOT}/.claude`, `${ROOT}/.claude/rules`])
  const rowIn = (tab: 'tree' | 'touched' | 'instructions', records: LogRecord[], path: string) => rowsFor(tab, ctx(records), { ...ui, expanded }).find((r) => r.path === path)!

  test('in Tree, Touched and Instructions: dim, muted name, ⊘ kept; a re-injected file is not dim', () => {
    for (const tab of ['tree', 'touched'] as const) {
      expect(rowIn(tab, base, dropped)).toMatchObject({ dim: true, tone: 'muted' })
      expect(marks(rowIn(tab, base, dropped))).toContain('⊘')
      expect(rowIn(tab, base, `${ROOT}/kept.ts`).dim).toBeFalsy()
    }
    expect(rowIn('instructions', base, rule)).toMatchObject({ dim: true, tone: 'muted' })
    expect(marks(rowIn('instructions', base, rule))).toContain('⊘')
  })

  test('a later read restores normal rendering', () => {
    const again = [...base, ev({ kind: 'read', path: dropped, ranges: [[1, 10]], totalLines: 1200, estTokens: 20 })]
    const row = rowIn('touched', again, dropped)
    expect(row.dim).toBeFalsy()
    expect(marks(row)).not.toContain('⊘')
  })

  test('a file only a subagent read (never in the main context) is not dimmed', () => {
    const sub = [ev({ kind: 'read', path: `${ROOT}/s.ts`, ranges: [[1, 2]], totalLines: 2, agentId: 'a1', agentType: 'Explore' })]
    expect(rowIn('touched', sub, `${ROOT}/s.ts`).dim).toBeFalsy()
  })

  for (const variant of ['dark', 'light'] as const) {
    for (const depth of ['256', 'truecolor'] as const) {
      test(`${variant} ${depth}: the fill is toned down and the name keeps 4.5:1, 3:1 when receding`, () => {
        const pal = defaultPalette(variant, depth)
        const dim = rowSegments(rowIn('touched', base, dropped), 60, pal, false)
        const plain = rowSegments({ ...rowIn('touched', base, dropped), dim: false, tone: 'text' }, 60, pal, false)
        const fill = fillBackground(pal)
        expect(plain.some((x) => x.bg === fill)).toBe(true)
        expect(dim.some((x) => x.bg === fill)).toBe(false)
        const dimFill = dim.find((x) => x.bg !== undefined)!.bg!
        // Toned down: closer to the panel background than the normal fill.
        expect(contrastRatio(dimFill, pal.background)).toBeLessThan(contrastRatio(fill, pal.background))
        for (const sel of [false, true]) {
          for (const x of rowSegments(rowIn('touched', base, dropped), 60, pal, sel)) {
            if (!x.name || !x.fg) continue
            const bg = x.bg ?? pal.background
            // A receding name (muted) holds 3:1; on a selected row every name reaches 4.5:1.
            const min = !sel && RECEDING.some((k) => pal.colors[k] === x.fg) ? 3 : 4.5
            expect(contrastRatio(x.fg, bg)).toBeGreaterThanOrEqual(min)
            if (depth === '256') expect(contrastRatio(quantize256(x.fg).hex, quantize256(bg).hex)).toBeGreaterThanOrEqual(min)
          }
        }
        // Dimmed: the name is no longer drawn in the full text colour.
        expect(dim.find((x) => x.name)!.fg).not.toBe(pal.colors.text)
      })
    }
  }

  // In 256 colours the half-way mix rounds to cube 59, a light grey brighter than the navy/maroon/olive
  // fills, with white text. Checked on the cells Claude Code draws in 256 colours.
  const cell = (hex: string) => quantize256(hex).hex
  const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  const configs: [string, Variant, string][] = [
    ['dark default', 'dark', '{}'],
    ['dark fill.darkness 0.4', 'dark', '{"fill.darkness":0.4}'],
    ['dark fill.darkness 0.9', 'dark', '{"fill.darkness":0.9}'],
    ['dark custom fills', 'dark', '{"fill":"#20a040","fill.edit":"#c06020","fill.commit":"#8040c0"}'],
    ['light default', 'light', '{}'],
    ['light fill.darkness 0.4', 'light', '{"fill.darkness":0.4}'],
    ['light fill.darkness 0.6', 'light', '{"fill.darkness":0.6}'],
  ]
  for (const [label, variant, config] of configs) {
    for (const tone of ['read', 'edit', 'commit'] as const) {
      test(`${label} 256: a dimmed ${tone} fill sits between the background and the live fill, with muted text`, () => {
        const pal = buildPalette(variant, parseConfig(config), '256')
        const row = { ...rowIn('touched', base, dropped), fillTone: tone }
        const dim = rowSegments(row, 60, pal, false)
        const live = rowSegments({ ...row, dim: false, tone: 'text' }, 60, pal, false)
        const bg = cell(pal.background)
        const liveFill = cell(live.find((x) => x.bg !== undefined)!.bg!)
        const dimFill = cell(dim.find((x) => x.bg !== undefined)!.bg!)
        expect(liveFill).not.toBe(bg)
        expect(dimFill).not.toBe(liveFill)
        expect(dimFill).not.toBe(bg)
        // Less prominent than the live fill: perceptually closer to the panel background. (Not by luminance alone:
        // maroon 52 is within 1.08:1 of #262626, and the only cells nearer it in luminance are blues.)
        expect(deltaE(dimFill, bg)).toBeLessThan(deltaE(liveFill, bg))
        // Keeps the state's hue or goes grey: never another state's colour.
        if (!/^#(..)\1\1$/.test(dimFill)) expect(hueDistance(hue(dimFill), hue(liveFill))).toBeLessThanOrEqual(30)
        const dimName = dim.find((x) => x.name)!
        const liveName = live.find((x) => x.name)!
        // Muted, not the white/black fallback, and readable on the drawn cells.
        expect(dimName.fg).toBe(pal.colors.muted)
        for (const x of dim.filter((s) => s.fg && s.text.trim() !== '')) {
          expect(x.fg).toBe(pal.colors.muted)
          expect(contrastRatio(cell(x.fg!), cell(x.bg ?? pal.background))).toBeGreaterThanOrEqual(4.5)
        }
        // Not brighter (dark) or darker (light) than a live row's name: luminance measured against the background's pole.
        const pole = variant === 'dark' ? '#000000' : '#ffffff'
        expect(contrastRatio(cell(dimName.fg!), pole)).toBeLessThanOrEqual(contrastRatio(cell(liveName.fg!), pole))
      })
    }
  }

  test('light 256 at fill.darkness 0.9: the live fill draws as the background, so the dim fill does too', () => {
    const pal = buildPalette('light', parseConfig('{"fill.darkness":0.9}'), '256')
    const dim = rowSegments(rowIn('touched', base, dropped), 60, pal, false)
    expect(cell(dim.find((x) => x.bg !== undefined)!.bg!)).toBe(cell(pal.background))
  })

  test('truecolor dark keeps the half-way dim fill (#2d2e3d for read) with muted text', () => {
    const pal = defaultPalette('dark', 'truecolor')
    const dim = rowSegments(rowIn('touched', base, dropped), 60, pal, false)
    expect(dim.find((x) => x.bg !== undefined)!.bg).toBe('#2d2e3d')
    expect(dim.find((x) => x.name)!.fg).toBe(pal.colors.muted)
  })
})

describe('Instructions tab groups', () => {
  test('Auto-loaded with ⚡, Skills per skill, plugin skills folded under one row per plugin', () => {
    const records: LogRecord[] = [
      ev({ kind: 'autoload', path: `${ROOT}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 }),
      ev({ kind: 'autoload', path: 'skill-description:demo', source: 'attachment', whole: true, totalLines: 1, estTokens: 5, origin: 'skillDescription', owner: { kind: 'skill', name: 'demo' } }),
      ev({ kind: 'skillLoad', path: `${ROOT}/.claude/skills/demo/SKILL.md`, source: 'skillPrompt', whole: true, estTokens: 30, owner: { kind: 'skill', name: 'demo' } }),
      ...['a', 'b', 'c'].map((n) =>
        ev({ kind: 'autoload', path: `skill-description:mkt:${n}`, source: 'attachment', whole: true, totalLines: 1, estTokens: 7, origin: 'skillDescription', owner: { kind: 'plugin', name: 'mkt' } }),
      ),
    ]
    const rows = instructionRows(ctx(records), ui)
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)).toEqual([
      '⚡ Auto-loaded',
      '  CLAUDE.md',
      'Skills',
      '  demo',
      '    description',
      '    SKILL.md',
      'Plugins and other',
      '  mkt',
    ])
    // The header carries `⚡` once; the row's gutter shows its coverage, and no row repeats `⚡`.
    expect(rows[1]!.glyph?.text).toBe('●')
    expect(rows.slice(1).some((r) => r.label.includes('⚡') || r.meta.some((m) => m.text === '⚡'))).toBe(false)
    expect(rows[7]).toMatchObject({ kind: 'plugin', expanded: false })
    expect(rows[7]!.meta.map((m) => m.text)).toEqual(['3 files', '≈21 tok'])
    const open = instructionRows(ctx(records), { ...ui, expanded: new Set(['p:mkt']) })
    expect(open.slice(8).map((r) => r.label)).toEqual(['a (description)', 'b (description)', 'c (description)'])
  })
})

describe('description-only skills fold', () => {
  const desc = (name: string, resolvedPath?: string) =>
    ev({ kind: 'autoload', path: `skill-description:${name}`, source: 'attachment', whole: true, totalLines: 1, estTokens: 5, origin: 'skillDescription', owner: { kind: 'skill', name }, ...(resolvedPath ? { resolvedPath } : {}) })
  const records: LogRecord[] = [
    desc('demo', `${ROOT}/.claude/skills/demo/SKILL.md`),
    desc('init'),
    desc('review'),
    desc('mine', '/home/u/.claude/skills/mine/SKILL.md'),
  ]

  test('built-in and user skills with only a description fold into one row; project skills keep their own', () => {
    const rows = instructionRows(ctx(records), ui)
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)).toEqual(['Skills', '  demo', '  other skills'])
    const fold = rows[2]!
    expect(fold).toMatchObject({ kind: 'plugin', key: 'p:skill-descriptions', expanded: false, glyph: { text: '▸' } })
    expect(fold.meta.map((m) => m.text)).toEqual(['3 descriptions', '≈15 tok'])
    expect(rows[0]!.meta.map((m) => m.text)).toEqual(['4', '≈20 tok'])
  })

  test('opening the fold lists each description; a search opens it too', () => {
    const open = instructionRows(ctx(records), { ...ui, expanded: new Set(['p:skill-descriptions']) })
    expect(open.slice(3).map((r) => `${r.depth}:${r.label}`)).toEqual(['2:init (description)', '2:mine (description)', '2:review (description)'])
    const found = instructionRows(ctx(records), { ...ui, query: 'review' })
    expect(found.map((r) => r.label)).toEqual(['Skills', 'other skills', 'review (description)'])
  })
})

describe('search', () => {
  test('matches paths relative to the project, not the absolute prefix', () => {
    const root = '/tmp/ccfiles-agents'
    const records: LogRecord[] = [
      { t: 'event', e: makeEvent({ kind: 'autoload', path: `${root}/AGENTS.md`, source: 'promptContext', whole: true, totalLines: 2, estTokens: 13, ts: 1 }) },
      { t: 'event', e: makeEvent({ kind: 'autoload', path: `${root}/.claude/rules/globs-control.md`, source: 'promptContext', whole: true, totalLines: 2, estTokens: 27, ts: 1 }) },
    ]
    const c: ViewContext = { state: replay(records), root, home: null, projectFiles: [`${root}/big.md`], git: null, pending: new Map(), now: 2 }
    const q = { ...ui, query: 'agents' }
    expect(touchedRows(c, q).map((r) => r.label)).toEqual(['AGENTS.md'])
    expect(instructionRows(c, q).filter((r) => r.kind === 'file').map((r) => r.label)).toEqual(['AGENTS.md'])
    expect(treeRows(c, q).filter((r) => r.kind === 'file').map((r) => r.label)).toEqual(['AGENTS.md'])
  })
})

describe('list window (follow and the ⋮ line)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ key: `r${i}`, kind: 'file', depth: 0, label: `r${i}`, path: `/p/r${i}`, file: { lastTs: i } as never, coverage: null, glyph: null, tone: 'text', lit: i === 2 || i === 29 ? 'read' : null, pending: false, meta: [] }) as Row)
  test('the follow target is in the window; activity outside is counted, not pinned; the window keeps one line for the note', () => {
    const p = initialPanel()
    const win = listWindow(p, rows, 9)
    expect(win.rows.map((r) => r.key)).toContain('r29')
    expect(win.rows).toHaveLength(8)
    expect(win).toMatchObject({ height: 8, hidden: 22, active: 1 })
  })
  test('the window has the same size whether rows are lit or not', () => {
    const p = initialPanel()
    p.follow = false
    const lit = listWindow(p, rows, 9)
    const dark = listWindow(p, rows.map((r) => ({ ...r, lit: null })), 9)
    expect(dark.rows.map((r) => r.key)).toEqual(lit.rows.map((r) => r.key))
    expect(dark.active).toBe(0)
  })
  test('a list that fits uses every line, with no note', () => {
    expect(listWindow(initialPanel(), rows.slice(0, 9), 9)).toMatchObject({ height: 9, hidden: 0 })
  })
})

describe('keyboard stays in the pane', () => {
  // The test kit can't observe a mod's own $.ui.focus call, so only the choice of target is tested here.
  const rows = treeRows(ctx([ev({ kind: 'read', path: `${ROOT}/full.ts`, ranges: [[1, 10]], totalLines: 10 })]), ui)
  test('after a press or a search Enter the ring goes to the selected row when it is drawn', () => {
    const p = initialPanel()
    p.selected.tree = `f:${ROOT}/full.ts`
    expect(focusTarget(p, rows)).toBe(`f:${ROOT}/full.ts`)
  })
  test('a selection that is no longer drawn, or the detail view, falls back to the header ? button, which every layout draws', () => {
    const p = initialPanel()
    p.selected.tree = `f:${ROOT}/gone.ts`
    expect(focusTarget(p, rows)).toBe('btn:help')
    p.selected.tree = `f:${ROOT}/full.ts`
    openDetail(p, `${ROOT}/full.ts`)
    expect(focusTarget(p, rows)).toBe('btn:help')
  })
  test('rows drawn by the rows Client are not ring stops: the ring goes to the ? button (never a hidden key)', () => {
    const p = initialPanel()
    p.selected.tree = `f:${ROOT}/full.ts`
    expect(focusTarget(p, rows, false)).toBe('btn:help')
  })
})

describe('fill tone by state', () => {
  test('read → ice blue, edited → rose, committed → gold; an edit after the commit is edited again; the drawn fill uses that tint', () => {
    const p = `${ROOT}/f.ts`
    const read = ev({ kind: 'read', path: p, ranges: [[1, 10]], totalLines: 10 })
    const edit = ev({ kind: 'edit', path: p, tool: 'Edit', linesAdded: 1 })
    const commit = ev({ kind: 'commit', path: p, tool: 'git commit', source: 'gitScan', sha: 'abc1234' })
    const tone = (records: LogRecord[]) => touchedRows(ctx(records), ui).find((r) => r.path === p)!.fillTone
    expect(tone([read])).toBe('read')
    expect(tone([read, edit])).toBe('edit')
    expect(tone([read, edit, commit])).toBe('commit')
    expect(tone([read, edit, commit, edit])).toBe('edit')
    const pal = defaultPalette('dark')
    const row = touchedRows(ctx([read, edit, commit]), ui).find((r) => r.path === p)!
    const segs = rowSegments(row, 40, pal, false)
    expect(segs.some((x) => x.bg === fillBackground(pal, 'commit'))).toBe(true)
  })
})

describe('alignment in every tab', () => {
  // Rows with every kind of mark: ↩ re-read, ⟳ reloaded, ✎ edited, ⚡ auto-loaded, ⊘ out of context, ? unverified,
  // AGENTS.md (? and no state glyph), deep folders, a description row and a plugin fold.
  const records: LogRecord[] = [
    ev({ kind: 'read', path: `${ROOT}/a/b/c/deep.ts`, ranges: [[1, 5]], totalLines: 10, estTokens: 50 }),
    ev({ kind: 'read', path: `${ROOT}/again.ts`, ranges: [[1, 5]], totalLines: 10, estTokens: 50 }),
    ev({ kind: 'read', path: `${ROOT}/again.ts`, ranges: [[1, 5]], totalLines: 10, estTokens: 50 }),
    ev({ kind: 'edit', path: `${ROOT}/edited.ts`, tool: 'Edit', linesAdded: 1 }),
    ev({ kind: 'autoload', path: `${ROOT}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 }),
    ev({ kind: 'autoload', path: `${ROOT}/AGENTS.md`, source: 'promptContext', whole: true, totalLines: 2, estTokens: 9, verified: false, viaFallback: true }),
    ev({ kind: 'read', path: `${ROOT}/dropped.md`, ranges: [[1, 3]], totalLines: 30, estTokens: 40 }),
    ev({ kind: 'read', path: `${ROOT}/kept.ts`, ranges: [[1, 10]], totalLines: 10, estTokens: 50 }),
    ev({ kind: 'compact', path: '', source: 'session' }),
    ev({ kind: 'read', path: `${ROOT}/kept.ts`, tool: 'n/a', source: 'compactRestore', ranges: [[1, 10]], estTokens: 60 }),
    ev({ kind: 'hit', path: `${ROOT}/guess.ts`, verified: false }),
    ev({ kind: 'autoload', path: 'skill-description:demo', source: 'attachment', whole: true, totalLines: 1, estTokens: 5, origin: 'skillDescription', owner: { kind: 'skill', name: 'demo' }, resolvedPath: `${ROOT}/.claude/skills/demo/SKILL.md` }),
    ev({ kind: 'autoload', path: 'skill-description:mkt:x', source: 'attachment', whole: true, totalLines: 1, estTokens: 7, origin: 'skillDescription', owner: { kind: 'plugin', name: 'mkt' } }),
    // A row lit just now (it shimmers) and one pending; dropped.md above is dimmed.
    ev({ kind: 'read', path: `${ROOT}/lit.ts`, ranges: [[1, 4]], totalLines: 8, estTokens: 30, ts: T - 100 }),
  ]
  const expanded = new Set([`${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/a/b/c`, 'p:mkt'])
  const pending = new Map([[`${ROOT}/pending.ts`, 'read' as const]])

  for (const tab of ['tree', 'touched', 'instructions'] as const) {
    for (const variant of ['dark', 'light'] as const) {
      for (const width of [39, 40, 44, 52, 59, 61, 71, 89, 90]) {
        const pal = defaultPalette(variant)
        test(`${tab} ${variant} at ${width} columns: each name starts at depth×2+3 and each row is exactly the pane width`, () => {
          const rows = rowsFor(tab, ctx(records, { pending, projectFiles: [`${ROOT}/untouched.ts`, `${ROOT}/pending.ts`] }), { ...ui, expanded })
          expect(rows.length).toBeGreaterThan(3)
          const marks = rows.map((r) => [r.glyph?.text ?? '', ...r.meta.map((m) => m.text)].join(' ')).join(' ')
          if (tab === 'touched') for (const m of ['↩1', '⟳', '✎', '⚡', '⊘', '?', 'reading']) expect(marks).toContain(m)
          if (tab !== 'instructions') {
            expect(rows.some((r) => r.dim)).toBe(true)
            expect(rows.some((r) => r.shimmer)).toBe(true)
          }
          for (const r of rows) {
            const segs = rowSegments(r, width, pal, false)
            expect(segs.reduce((n, x) => n + cellWidth(x.text), 0)).toBe(width)
            const start = segs.findIndex((x) => x.name)
            const col = segs.slice(0, start).reduce((n, x) => n + cellWidth(x.text), 0)
            if (col !== r.depth * 2 + 3) throw new Error(`${tab} ${r.label}: name at column ${col}, expected ${r.depth * 2 + 3}`)
          }
          if (tab !== 'instructions') expect(rows.some((r) => r.label.endsWith('AGENTS.md') && r.glyph?.text !== '⚡')).toBe(true)
        })
      }
    }
  }
})
