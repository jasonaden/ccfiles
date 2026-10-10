// Claude Code loads and outside roots as Tree sections, and focus.
import { describe, expect, test } from 'claude-code/testing'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { snapshot } from '../src/git.ts'
import { initialPanel, activate, collapse, expand, toggleCollapse } from '../src/view/panel.ts'
import { touchedRows, treeRows, type Row, type ViewContext } from '../src/view/rows.ts'

const P = '/p'
const O = '/work/other'
const T = 1_000_000
const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })
const read = (path: string) => ev({ kind: 'read', path, ranges: [[1, 5]], totalLines: 5, estTokens: 40 })
const ctx = (records: LogRecord[], extra: Partial<ViewContext> = {}): ViewContext => ({
  state: replay(records), root: P, home: '/home/me', projectFiles: [`${P}/a.ts`, `${P}/src/b.ts`], git: null, pending: new Map(), now: T, ...extra,
})
const ui = (...keys: string[]) => ({ expanded: new Set(keys), query: '', sort: 'recent' as const })
const labels = (rows: readonly Row[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)

describe('outside roots', () => {
  const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`, `${O}/src/y.ts`, `${O}/README.md`] }]

  test('no outside root, no loads: the plain project tree, nothing extra', () => {
    const rows = treeRows(ctx([read(`${P}/a.ts`)], { loads: 'hide' }), ui())
    expect(rows.some((r) => r.kind === 'section')).toBe(false)
  })

  test('an outside root is a section under the project: header, touched path open, untouched siblings folded', () => {
    const rows = treeRows(ctx([read(`${P}/a.ts`), read(`${O}/src/x.ts`)], { outside }), ui())
    const at = rows.findIndex((r) => r.kind === 'section')
    expect(rows[at]).toMatchObject({ key: `r:${O}`, label: O, path: O, expanded: true })
    expect(labels(rows.slice(at + 1))).toEqual(['  src', '    x.ts', '    1 file not read', '  1 file not read'])
  })

  test('a press closes the section; its files stay out of the project tree', () => {
    const c = ctx([read(`${O}/src/x.ts`)], { outside })
    const p = initialPanel()
    const sec = treeRows(c, p).find((r) => r.kind === 'section')!
    activate(p, sec)
    const rows = treeRows(c, p)
    expect(rows.find((r) => r.kind === 'section')).toMatchObject({ expanded: false })
    expect(rows.some((r) => r.path === `${O}/src/x.ts`)).toBe(false)
  })
})

describe('focus', () => {
  test('focus on a folder shows only its subtree, at depth 0', () => {
    const rows = treeRows(ctx([read(`${P}/src/b.ts`)], { focus: `${P}/src` }), ui())
    expect(labels(rows)).toEqual(['b.ts'])
  })

  test('focus above the root lists the project as a folder with its rollup', () => {
    const rows = treeRows(ctx([read(`${P}/a.ts`)], { focus: '/', listedDirs: ['/p', '/q'] }), ui())
    const proj = rows.find((r) => r.kind === 'dir' && r.path === P)
    expect(proj).toBeDefined()
    expect(proj!.cells?.tokens).not.toBe(null)
    expect(rows.some((r) => r.kind === 'section')).toBe(false)
  })
})

describe('Claude Code loads in the Tree', () => {
  const load = (path: string): LogRecord => ({ t: 'event', e: makeEvent({ kind: 'autoload', source: 'instructions', tool: 'n/a', path, ts: T - 5000, ranges: [[1, 3]], totalLines: 3, estTokens: 30 } as never) })

  test('show: a load outside the project goes in a collapsed `Loaded by Claude Code` section', () => {
    const rows = treeRows(ctx([read(`${P}/a.ts`), load('/home/me/.claude/CLAUDE.md')]), ui())
    const sec = rows.find((r) => r.key === 's:loads')
    expect(sec).toMatchObject({ kind: 'section', label: 'Loaded by Claude Code', expanded: false })
    const open = treeRows(ctx([read(`${P}/a.ts`), load('/home/me/.claude/CLAUDE.md')]), ui('s:loads'))
    expect(open.some((r) => r.label === '~/.claude/CLAUDE.md')).toBe(true)
  })

  test('hide: no loads section', () => {
    const rows = treeRows(ctx([read(`${P}/a.ts`), load('/home/me/.claude/CLAUDE.md')], { loads: 'hide' }), ui())
    expect(rows.some((r) => r.key === 's:loads')).toBe(false)
  })
})

describe('collapse toggle', () => {
  test('⊟ closes every folder; ⊞ reopens the ancestors of changed files; opening by hand clears it', () => {
    const p = initialPanel()
    p.expanded.add(`${P}/src`)
    toggleCollapse(p, [`${P}/src/b.ts`], P)
    expect(p.collapsed).toBe(true)
    expect(p.expanded.has(`${P}/src`)).toBe(false)
    toggleCollapse(p, [`${P}/src/b.ts`], P)
    expect(p.collapsed).toBe(false)
    expect(p.expanded.has(`${P}/src`)).toBe(true)
    toggleCollapse(p, [], P)
    const c = ctx([read(`${P}/src/b.ts`)])
    const dir = treeRows(c, p).find((r) => r.kind === 'dir')!
    activate(p, dir)
    expect(p.collapsed).toBe(false)
  })
})

describe('git per outside section', () => {
  const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`, `${O}/src/y.ts`, `${O}/README.md`] }]
  // The other repo: x.ts modified, y.ts untracked, and a change far from anything touched.
  const other = snapshot({ root: O, status: ' M src/x.ts\0?? src/y.ts\0 M lib/far.ts\0', numstat: '4\t2\tsrc/x.ts\n1\t1\tlib/far.ts\n', aheadBehind: '', branch: 'feature', head: 'abc' })
  // The session repo says nothing about the other repo's files.
  const session = snapshot({ root: P, status: ' M a.ts\0', numstat: '1\t0\ta.ts\n', aheadBehind: '', branch: 'main', head: 'def' })
  const records = [read(`${P}/a.ts`), read(`${O}/src/x.ts`)]
  const gitOf = (root: string) => (root === O ? other : null)

  test('outside rows take their name colour and git meta from their section\'s repo, project rows from the session\'s', () => {
    const rows = treeRows(ctx(records, { outside, git: session, gitOf }), ui())
    const x = rows.find((r) => r.path === `${O}/src/x.ts`)!
    expect(x.tone).toBe('git.M')
    expect(x.cells!.git.map((c) => c.text)).toEqual(['+4', '−2'])
    expect(rows.find((r) => r.path === `${P}/a.ts`)!.tone).toBe('git.M')
  })

  test('without a snapshot for the section, outside rows show no git state', () => {
    const rows = treeRows(ctx(records, { outside, git: session }), ui())
    const x = rows.find((r) => r.path === `${O}/src/x.ts`)!
    expect(x.tone).toBe('text')
    expect(x.cells!.git).toEqual([])
  })

  test('the section\'s git colours what is listed but adds no folders: a change far from touched files stays out', () => {
    const rows = treeRows(ctx(records, { outside, git: session, gitOf }), ui(`u:${O}/src`))
    expect(rows.some((r) => r.path?.includes('lib'))).toBe(false)
    expect(rows.find((r) => r.path === `${O}/src/y.ts`)!.tone).toBe('git.A')
  })

  test('focused inside the section, its rows still read the section\'s repo', () => {
    const rows = treeRows(ctx(records, { outside, git: session, gitOf, focus: `${O}/src` }), ui())
    expect(rows.find((r) => r.path === `${O}/src/x.ts`)!.tone).toBe('git.M')
  })

  test('the Touched tab colours outside files from their section\'s repo too', () => {
    const rows = touchedRows(ctx(records, { outside, git: session, gitOf }), ui())
    expect(rows.find((r) => r.path === `${O}/src/x.ts`)!.tone).toBe('git.M')
  })
})

describe('Touched tab grouped by section', () => {
  const W = '/srv/lib'
  const at = (path: string, ts: number, estTokens: number) => ev({ kind: 'read', path, ranges: [[1, 5]], totalLines: 5, estTokens, ts })
  const records = [
    at(`${O}/src/x.ts`, T - 9000, 500),
    at(`${P}/a.ts`, T - 8000, 10),
    at(`${W}/w.ts`, T - 7000, 30),
    at(`${O}/README.md`, T - 6000, 20),
    at(`${P}/src/b.ts`, T - 5000, 300),
  ]
  const outside = [
    { root: O, files: [`${O}/src/x.ts`, `${O}/README.md`], listing: [] },
    { root: W, files: [`${W}/w.ts`], listing: [] },
  ]
  const c = ctx(records, { outside })

  test('project files first, then one header per outside section in the Tree\'s order, its files under it', () => {
    expect(labels(touchedRows(c, ui()))).toEqual(['src/b.ts', 'a.ts', O, '  README.md', '  src/x.ts', W, '  w.ts'])
  })

  test('section headers use the Tree\'s labels and section row kind', () => {
    const tree = treeRows(c, ui()).filter((r) => r.kind === 'section').map((r) => r.label)
    const touched = touchedRows(c, ui()).filter((r) => r.kind === 'section')
    expect(touched.map((r) => r.label)).toEqual(tree)
    expect(touched[0]).toMatchObject({ path: O, expanded: true, cells: { lines: '2', tokens: 520 } })
  })

  test('each sort order holds inside every group', () => {
    const tokens = labels(touchedRows(c, { ...ui(), sort: 'tokens' }))
    expect(tokens).toEqual(['src/b.ts', 'a.ts', O, '  src/x.ts', '  README.md', W, '  w.ts'])
  })

  test('a press closes a group and leaves the Tree\'s section open; h and l close and reopen it', () => {
    const p = initialPanel()
    p.tab = 'touched'
    const header = touchedRows(c, p).find((r) => r.kind === 'section')!
    activate(p, header)
    expect(labels(touchedRows(c, p))).toEqual(['src/b.ts', 'a.ts', O, W, '  w.ts'])
    expect(treeRows(c, p).find((r) => r.kind === 'section')!.expanded).toBe(true)
    expand(p, touchedRows(c, p))
    expect(touchedRows(c, p).find((r) => r.key === header.key)!.expanded).toBe(true)
    collapse(p, touchedRows(c, p), 20)
    expect(touchedRows(c, p).find((r) => r.key === header.key)!.expanded).toBe(false)
  })

  test('no outside root: the flat list, unchanged', () => {
    expect(labels(touchedRows(ctx([at(`${P}/a.ts`, T - 1, 1)]), ui()))).toEqual(['a.ts'])
  })
})

describe('h and l on an outside section in the Tree', () => {
  test('h closes an open section and l opens it again', () => {
    const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`] }]
    const c = ctx([read(`${O}/src/x.ts`)], { outside })
    const p = initialPanel()
    p.selected.tree = `r:${O}`
    collapse(p, treeRows(c, p), 20)
    expect(treeRows(c, p).find((r) => r.kind === 'section')!.expanded).toBe(false)
    expand(p, treeRows(c, p))
    expect(treeRows(c, p).find((r) => r.kind === 'section')!.expanded).toBe(true)
  })
})

describe('folder git rollup', () => {
  const git = (files: [string, 'M' | '?' | 'A' | 'D', number, number][]) => ({
    root: P, branch: 'main', head: 'h', ahead: 0, behind: 0,
    files: new Map(files.map(([path, letter, added, removed]) => [path, { path, letter, staged: false, added, removed, binary: false }])),
  })
  test('a folder with changes takes the git colour; collapsed, it shows +N −N; open, its files carry the meta', () => {
    const c = ctx([read(`${P}/a.ts`)], { git: git([[`${P}/src/b.ts`, 'M', 19, 5]]) })
    const closed = treeRows(c, ui()).find((r) => r.path === `${P}/src`)!
    expect(closed.tone).toBe('git.M')
    expect(closed.cells?.git.map((g) => g.text)).toEqual(['+19', '−5'])
    const open = treeRows(c, ui(`${P}/src`)).find((r) => r.path === `${P}/src`)!
    expect(open.cells?.git).toEqual([])
  })
  test('only new files: git.A and `N new`; a clean folder keeps text/muted', () => {
    // An untracked-only folder folds as untouched: open the fold to see it.
    const c = ctx([read(`${P}/a.ts`)], { git: git([[`${P}/src/b.ts`, '?', 0, 0]]) })
    const dir = treeRows(c, ui(`u:${P}`)).find((r) => r.path === `${P}/src`)!
    expect(dir.tone).toBe('git.A')
    expect(dir.cells?.git.map((g) => g.text)).toEqual(['1 new'])
  })
})

const autoload = (path: string, estTokens = 30): LogRecord => ({ t: 'event', e: makeEvent({ kind: 'autoload', source: 'instructions', tool: 'n/a', path, ts: T - 5000, ranges: [[1, 3]], totalLines: 3, estTokens } as never) })

describe('a section above a package session', () => {
  // Session in /m/pkg; Claude read /m/README.md, so /m is a (loose) section holding the session root.
  const outside = [{ root: '/m', files: ['/m/README.md'], listing: ['/m/README.md', '/m/package.json'] }]
  const c = ctx([read('/m/pkg/a.ts'), read('/m/README.md'), read('/m/pkg/src/b.ts')], { root: '/m/pkg', projectFiles: ['/m/pkg/a.ts', '/m/pkg/src/b.ts'], listedDirs: ['/m/pkg', '/m/other'], outside, loads: 'hide' })

  test('the Tree shows each session file once, under the session root; the section holds only its own file', () => {
    const rows = treeRows(c, ui('/m/pkg/src'))
    expect(rows.filter((r) => r.path === '/m/pkg/a.ts').length).toBe(1)
    expect(rows.filter((r) => r.path === '/m/pkg/src/b.ts').length).toBe(1)
    const at = rows.findIndex((r) => r.key === 'r:/m')
    expect(labels(rows.slice(at + 1))).toEqual(['  README.md'])
  })

  test('Touched keeps session files out of the section\'s group and its total', () => {
    const rows = touchedRows(c, ui())
    expect(rows.filter((r) => r.depth === 0 && r.kind === 'file').map((r) => r.path).sort()).toEqual(['/m/pkg/a.ts', '/m/pkg/src/b.ts'])
    expect(rows.find((r) => r.key === 't:/m')).toMatchObject({ cells: { lines: '1', tokens: 40 } })
  })

  test('a CLAUDE.md in the folder above stays in Loaded by Claude Code', () => {
    const rows = treeRows({ ...c, state: replay([read('/m/README.md'), autoload('/m/CLAUDE.md')]), loads: 'show' }, ui('s:loads'))
    expect(rows.find((r) => r.key === 's:loads')).toBeDefined()
    expect(rows.filter((r) => r.path === '/m/CLAUDE.md').length).toBe(1)
  })
})

describe('instruction files inside an outside root', () => {
  const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`, `${O}/CLAUDE.md`] }]
  const c = ctx([read(`${O}/src/x.ts`), autoload(`${O}/CLAUDE.md`), autoload('/home/me/.claude/CLAUDE.md')], { outside })

  test('sit only in their section, not in Loaded by Claude Code', () => {
    const rows = treeRows(c, ui('s:loads'))
    expect(rows.filter((r) => r.path === `${O}/CLAUDE.md`).length).toBe(1)
    const loads = rows.findIndex((r) => r.key === 's:loads')
    expect(rows[loads]!.cells).toMatchObject({ lines: '1', tokens: 30 })
    expect(rows[loads + 1]!.path).toBe('/home/me/.claude/CLAUDE.md')
  })

  test('the section header counts them like its folders do', () => {
    // src closed, so its row carries its rollup.
    const rows = treeRows(c, ui(`x:${O}/src`))
    const header = rows.find((r) => r.key === `r:${O}`)!
    expect(header.cells).toMatchObject({ lines: '2', tokens: 70 })
    const top = rows.filter((r) => r.depth === 1)
    expect(top.reduce((n, r) => n + (r.cells?.tokens ?? 0), 0)).toBe(70)
  })
})

describe('⊟ / ⊞ with outside sections', () => {
  const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`, `${O}/src/y.ts`] }]
  const c = ctx([read(`${O}/src/x.ts`)], { outside })
  const src = (p: ReturnType<typeof initialPanel>) => treeRows(c, p).find((r) => r.path === `${O}/src`)!

  test('⊟ closes the section\'s open folders; ⊞ opens them again', () => {
    const p = initialPanel()
    expect(src(p).expanded).toBe(true)
    toggleCollapse(p, [`${O}/src/x.ts`], P)
    expect(src(p).expanded).toBe(false)
    toggleCollapse(p, [`${O}/src/x.ts`], P)
    expect(src(p).expanded).toBe(true)
  })

  test('a folder closed by hand stays closed through ⊟', () => {
    const p = initialPanel()
    activate(p, src(p))
    expect(src(p).expanded).toBe(false)
    toggleCollapse(p, [`${O}/src/x.ts`], P)
    expect(src(p).expanded).toBe(false)
  })

  test('h and l close and open such a folder', () => {
    const p = initialPanel()
    p.selected.tree = `d:${O}/src`
    collapse(p, treeRows(c, p), 20)
    expect(src(p).expanded).toBe(false)
    expand(p, treeRows(c, p))
    expect(src(p).expanded).toBe(true)
  })

  test('opening one by hand after ⊟ clears ⊞; Touched groups keep their state', () => {
    const p = initialPanel()
    p.expanded.add(`t:${O}`)
    toggleCollapse(p, [`${O}/src/x.ts`], P)
    activate(p, src(p))
    expect(src(p).expanded).toBe(true)
    expect(p.collapsed).toBe(false)
    expect(p.expanded.has(`t:${O}`)).toBe(true)
  })
})

describe('focus on an outside section\'s root', () => {
  test('keeps the deeper folds from the section\'s listings', () => {
    const outside = [{ root: O, files: [`${O}/src/x.ts`], listing: [`${O}/src/x.ts`, `${O}/src/y.ts`, `${O}/README.md`] }]
    // The hook adds only the focused folder's own listing to projectFiles.
    const c = ctx([read(`${O}/src/x.ts`)], { outside, focus: O, projectFiles: [`${P}/a.ts`, `${O}/README.md`], listedDirs: [`${O}/src`] })
    expect(labels(treeRows(c, ui()))).toEqual(['src', '  x.ts', '  1 file not read', '1 file not read'])
  })
})

describe('home as a section', () => {
  const H = '/home/me'
  const R = `${H}/Projects/other`
  const outside = [
    { root: H, files: [`${H}/.zshrc`], listing: [] },
    { root: R, files: [`${R}/a.ts`], listing: [`${R}/a.ts`] },
  ]
  const c = ctx([read(`${H}/.zshrc`), read(`${R}/a.ts`), autoload(`${H}/.claude/CLAUDE.md`)], { outside, listedDirs: [`${H}/Projects`] })

  test('~ holds only the files directly in it; the repo under it keeps its own section; ~/.claude loads stay apart', () => {
    const rows = treeRows(c, ui('s:loads'))
    const home = rows.findIndex((r) => r.key === `r:${H}`)
    const other = rows.findIndex((r) => r.key === `r:${R}`)
    expect(labels(rows.slice(home + 1, other))).toEqual(['  .zshrc'])
    expect(rows.filter((r) => r.path === `${R}/a.ts`).length).toBe(1)
    expect(rows.filter((r) => r.path === `${H}/.claude/CLAUDE.md`).length).toBe(1)
    expect(rows[rows.findIndex((r) => r.key === 's:loads') + 1]!.path).toBe(`${H}/.claude/CLAUDE.md`)
  })

  test('Touched: the ~ group holds only its own files', () => {
    const rows = touchedRows(c, ui())
    const home = rows.findIndex((r) => r.key === `t:${H}`)
    expect(rows[home]!.cells?.lines).toBe('1')
    expect(rows[home + 1]!.path).toBe(`${H}/.zshrc`)
  })
})

describe('a collapsed folder says when it lit', () => {
  test('litAt is the newest lit file\'s time; an open folder has none', () => {
    const c = ctx([ev({ kind: 'read', path: `${P}/src/b.ts`, ranges: [[1, 5]], totalLines: 5, estTokens: 40, ts: T - 500 })])
    expect(treeRows(c, ui()).find((r) => r.path === `${P}/src`)).toMatchObject({ lit: 'read', litAt: T - 500 })
    expect(treeRows(c, ui(`${P}/src`)).find((r) => r.path === `${P}/src`)!.litAt).toBeUndefined()
  })
})
