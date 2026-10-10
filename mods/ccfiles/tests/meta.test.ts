// Row meta wording and the glyph set with its help view and legend.
import { describe, expect, test } from 'claude-code/testing'
import type { GitFile, GitSnapshot, NumStat } from '../src/git.ts'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { detailLines, helpLines } from '../src/view/detail.ts'
import { GLYPH_TABLE, KEY_TABLE, META_WORDS } from '../src/view/glyphs.ts'
import { MIN_TAG_MS, rowsFor, touchedRows, treeRows, type Row, type ViewContext } from '../src/view/rows.ts'
import { cellWidth } from '../src/view/text.ts'
import { rowParts } from '../src/view/draw.ts'
import { defaultPalette } from '../src/palette.ts'
import { BIG, CWD, SMALL, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'

const ROOT = '/p'
const T = 1_000_000
const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })
const gitFile = (path: string, letter: GitFile['letter'], added = 0, removed = 0, binary = false): GitFile & NumStat => ({ path: `${ROOT}/${path}`, letter, staged: false, added, removed, binary })
const git = (files: (GitFile & NumStat)[]): GitSnapshot => ({ root: ROOT, branch: 'main', head: 'abc', ahead: 0, behind: 0, files: new Map(files.map((f) => [f.path, f])) })

function ctx(records: LogRecord[], extra: Partial<ViewContext> = {}): ViewContext {
  return { state: replay(records), root: ROOT, home: '/home/u', projectFiles: [], git: null, pending: new Map(), now: T, ...extra }
}
const ui = { expanded: new Set<string>(), query: '', sort: 'recent' as const }
const meta = (r: Row | undefined) => (r?.meta ?? []).map((m) => m.text)

describe('meta wording', () => {
  const files = [
    gitFile('untracked.ts', '?'),
    gitFile('added.ts', 'A', 12, 0),
    gitFile('modified.ts', 'M', 3, 1),
    gitFile('binary.png', 'M', 0, 0, true),
    gitFile('deleted.ts', 'D', 0, 9),
    gitFile('renamed.ts', 'R'),
    gitFile('ignored.log', '!'),
  ]
  const c = ctx([ev({ kind: 'read', path: `${ROOT}/modified.ts`, ranges: [[1, 74]], totalLines: 210 })], { git: git(files), projectFiles: files.map((f) => f.path) })
  // The untouched ones sit in the root's fold: open it.
  const rows = treeRows(c, { ...ui, expanded: new Set([`u:${ROOT}`]) })
  const row = (name: string) => rows.find((r) => r.path === `${ROOT}/${name}`)

  test('untracked and added show `new`, never `??`', () => {
    expect(meta(row('untracked.ts'))).toContain('new')
    expect(meta(row('added.ts'))).toEqual(expect.arrayContaining(['+12', '−0', 'new']))
  })
  test('modified keeps +N −N and drops the bare M; `mod` only without line counts', () => {
    expect(meta(row('modified.ts'))).toEqual(expect.arrayContaining(['+3', '−1']))
    expect(meta(row('modified.ts'))).not.toContain('M')
    expect(meta(row('modified.ts'))).not.toContain('mod')
    expect(meta(row('binary.png'))).toContain('mod')
  })
  test('deleted `del`, renamed `ren`, ignored receding (`git.ignored`) with no marker', () => {
    expect(meta(row('deleted.ts'))).toContain('del')
    expect(meta(row('renamed.ts'))).toContain('ren')
    expect(meta(row('ignored.log'))).toEqual([])
    expect(row('ignored.log')!.tone).toBe('git.ignored')
  })
  test('a partial read of a 210-line file shows 74/210, never a bare 74 or 210', () => {
    const m = meta(row('modified.ts'))
    expect(m).toContain('74/210')
    expect(m).not.toContain('74')
    expect(m).not.toContain('210')
  })
  test('lines read are the merged read intervals, not the total', () => {
    const p = `${ROOT}/two.ts`
    const r = touchedRows(ctx([ev({ kind: 'read', path: p, ranges: [[1, 10]], totalLines: 1323 }), ev({ kind: 'read', path: p, ranges: [[5, 20]], totalLines: 1323 })]), ui)[0]!
    expect(meta(r)).toContain('20/1.3k')
  })
  test('no row in any tab shows `??` or a bare git letter', () => {
    for (const tab of ['tree', 'touched', 'instructions'] as const) {
      for (const r of rowsFor(tab, c, ui)) {
        for (const m of meta(r)) {
          expect(m).not.toBe('??')
          expect(m).not.toMatch(/^[AMDR!]$/)
        }
      }
    }
  })
  test('`?` stays the unverified mark only', () => {
    const r = touchedRows(ctx([ev({ kind: 'hit', path: `${ROOT}/guess.ts`, verified: false })], { git: git([gitFile('guess.ts', '?')]) }), ui)[0]!
    expect(meta(r)).toEqual(expect.arrayContaining(['?', 'new']))
  })
})

describe('glyphs and legend', () => {
  const glyphOf = (records: LogRecord[], name: string, extra: Partial<ViewContext> = {}) => touchedRows(ctx(records, extra), ui).find((r) => r.path === `${ROOT}/${name}`)?.glyph?.text
  test('each state draws its glyph', () => {
    expect(glyphOf([ev({ kind: 'read', path: `${ROOT}/a`, ranges: [[1, 10]], totalLines: 10 })], 'a')).toBe('●')
    expect(glyphOf([ev({ kind: 'read', path: `${ROOT}/a`, ranges: [[1, 5]], totalLines: 10 })], 'a')).toBe('◐')
    expect(glyphOf([ev({ kind: 'read', path: `${ROOT}/a`, unknownRange: true, totalLines: 10 })], 'a')).toBe('◐')
    expect(glyphOf([ev({ kind: 'hit', path: `${ROOT}/a` })], 'a')).toBe('◇')
    expect(glyphOf([ev({ kind: 'edit', path: `${ROOT}/a`, tool: 'Edit', linesAdded: 1 })], 'a')).toBe('✎')
    expect(glyphOf([ev({ kind: 'commit', path: `${ROOT}/a`, tool: 'git commit', source: 'gitScan', sha: 'abc1234' })], 'a')).toBe('◆')
    expect(glyphOf([ev({ kind: 'listing', path: `${ROOT}/a` })], 'a')).toBe('·')
    expect(glyphOf([ev({ kind: 'hit', path: `${ROOT}/a` })], 'a', { pending: new Map([[`${ROOT}/a`, 'read']]) })).toBe('◌')
  })
  test('`·` stays: Glob, find, wc and `ls <file>` listings draw it; nothing draws a cd target, so the table never says so', () => {
    for (const tool of ['Glob', 'Bash:find', 'Bash:wc', 'Bash:ls']) expect(glyphOf([ev({ kind: 'listing', path: `${ROOT}/a`, tool })], 'a')).toBe('·')
    const seen = GLYPH_TABLE.find((g) => g.glyph === '·')!
    expect(seen.meaning).toBe('seen only (listed by ls, find, wc or Glob)')
    expect(GLYPH_TABLE.find((g) => g.glyph === '◇')!.meaning).toBe('matched by a search (grep, rg or Grep), not read')
  })
  test('every glyph a file or folder row can draw is in the table (or a folder ▸ ▾)', () => {
    const records: LogRecord[] = [
      ev({ kind: 'read', path: `${ROOT}/d/full.ts`, ranges: [[1, 10]], totalLines: 10, ts: T - 100 }),
      ev({ kind: 'read', path: `${ROOT}/partial.ts`, ranges: [[1, 5]], totalLines: 10 }),
      ev({ kind: 'hit', path: `${ROOT}/e/hit.ts`, ts: T - 100 }),
      ev({ kind: 'edit', path: `${ROOT}/f/edit.ts`, tool: 'Edit', linesAdded: 1, ts: T - 100 }),
      ev({ kind: 'commit', path: `${ROOT}/g/c.ts`, tool: 'git commit', source: 'gitScan', sha: 'abc1234', ts: T - 100 }),
      ev({ kind: 'autoload', path: `${ROOT}/CLAUDE.md`, source: 'promptContext', whole: true, totalLines: 3, estTokens: 10 }),
      ev({ kind: 'autoload', path: '/home/u/.claude/projects/-p/memory/MEMORY.md', source: 'promptContext', ranges: [[1, 200]], totalLines: 260, capped: true, origin: 'memory', estTokens: 2000 }),
    ]
    const c = ctx(records, { pending: new Map([[`${ROOT}/h/p.ts`, 'read']]), projectFiles: [`${ROOT}/h/p.ts`, `${ROOT}/u.ts`] })
    const table = new Set([...GLYPH_TABLE.map((g) => g.glyph), '▸', '▾'])
    // The table lists the meter steps the gutter draws (`◐` in the row model draws as one), so
    // the check reads the drawn gutter of every tab's rows (all three draw through the anatomy).
    const look = { glyphs: 'plain' as const, value: 'tokens' as const, now: T }
    for (const tab of ['tree', 'touched', 'instructions'] as const) {
      for (const r of rowsFor(tab, c, ui)) {
        const parts = rowParts(r, defaultPalette('dark'), look, false)
        if (parts.gutter) expect([r.key, table.has(parts.gutter.text)]).toEqual([r.key, true])
        if (parts.caret) expect(table.has(parts.caret.text)).toBe(true)
      }
    }
  })
  test('the help view lists every glyph of the table with its meaning, and every meta word', () => {
    const text = helpLines().map((l) => l.map((c) => c.text).join('')).join('\n')
    for (const g of GLYPH_TABLE) expect(text).toContain(`${g.glyph}  ${g.meaning}`)
    for (const m of META_WORDS) expect(text).toContain(m.text)
    expect(text).toContain('?')
  })
  test('the help view lists every key, `g` (help) included; no `?` key', () => {
    const help = helpLines().map((l) => l.map((c) => c.text).join(''))
    for (const k of KEY_TABLE) expect(help).toContain(`${k.keys}  ${k.meaning}`)
    expect(KEY_TABLE.find((k) => k.keys === 'g')?.meaning).toMatch(/help/)
    expect(KEY_TABLE.some((k) => k.keys.split(/[ /]+/).includes('?'))).toBe(false)
  })
  test('the detail view ends with the same key', () => {
    const f = replay([ev({ kind: 'read', path: `${ROOT}/a.ts`, ranges: [[1, 74]], totalLines: 210 })]).files.get(`${ROOT}/a.ts`)!
    const detail = detailLines(f, { root: ROOT, home: null, git: null, themeHint: null }).map((l) => l.map((c) => c.text).join(''))
    const help = helpLines().map((l) => l.map((c) => c.text).join(''))
    expect(detail.slice(-help.length)).toEqual(help)
    expect(detail.join('\n')).toContain('74/210 lines read')
  })
})

// No key legend row at any width; the help view (`g`) is the
// legend, and lists the glyphs and meter steps (checked on helpLines above).
describe('no drawn legend line; the help view is the legend', () => {
  test('at 39, 60 and 100 columns no line carries `x: ` key text or a glyph legend; `g` opens the help view', async ($, on) => {
    const h = harness(on)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: `${CWD}/big.md`, offset: 1, limit: 200 }, readResult(`${CWD}/big.md`, BIG, 1, 200))
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await h.clock.advance(MIN_TAG_MS)
    for (const width of [39, 60, 100]) {
      const ui = await $.ui.mount(pane(width, 16))
      for (const l of await screen(ui)) {
        expect(cellWidth(l)).toBeLessThanOrEqual(width)
        expect(l).not.toMatch(/(^| )[a-z0-9]: /)
        expect(l).not.toMatch(/● read|◐ part/)
      }
      await ui.press({ key: 'key:g' })
      expect((await screen(ui)).some((l) => /^help\b/.test(l))).toBe(true)
      for (const l of await screen(ui)) expect(l).not.toMatch(/(^| )[a-z0-9]: /)
      await ui.press({ key: 'key:d' })
      expect((await screen(ui)).some((l) => /^help\b/.test(l))).toBe(false)
      await ui.unmount()
    }
  })
})
