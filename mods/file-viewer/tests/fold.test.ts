// Untouched siblings fold into one row.
import { describe, expect, test } from 'claude-code/testing'
import type { GitSnapshot } from '../src/git.ts'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { initialPanel, activate, collapse, expand } from '../src/view/panel.ts'
import { treeRows, type Row, type ViewContext } from '../src/view/rows.ts'
import { CWD, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clickRow, clientLines } from './rows-client.ts'

const ADR_NAMES = [
  '001-record-decisions.md', '002-monorepo.md', '003-doc-wiki-format.md', '004-query-index.md', '005-auth.md', '006-storage.md',
  '007-search.md', '008-ranking.md', '009-sync.md', '010-offline.md', '011-telemetry.md', '012-plugins.md', '013-themes.md',
  '014-release.md', '015-data-retention-policy-docs.md', '016-retention.md',
]

/** The fixture: docs/adr/ with 16 ADRs, a README and 2 subfolders. */
function fixture(root: string): string[] {
  return [
    ...ADR_NAMES.map((n) => `${root}/docs/adr/${n}`),
    `${root}/docs/adr/README.md`,
    `${root}/docs/adr/drafts/017-draft.md`,
    `${root}/docs/adr/superseded/000-old.md`,
  ]
}

const P = '/p'
const T = 1_000_000
const ADR = `${P}/docs/adr`
const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ts: T - 10_000, ...e }) })
const read = (name: string) => ev({ kind: 'read', path: `${ADR}/${name}`, ranges: [[1, 5]], totalLines: 5 })
const ctx = (records: LogRecord[], extra: Partial<ViewContext> = {}): ViewContext => ({ state: replay(records), root: P, home: null, projectFiles: fixture(P), git: null, pending: new Map(), now: T, ...extra })
const open = (...keys: string[]) => ({ expanded: new Set([`${P}/docs`, ADR, ...keys]), query: '', sort: 'recent' as const })
const labels = (rows: readonly Row[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)

describe('fold untouched siblings', () => {
  test('only 015 read: docs/ › adr/ › 015 plus one collapsed `16 files, 2 folders not read` row', () => {
    const rows = treeRows(ctx([read('015-data-retention-policy-docs.md')]), open())
    expect(labels(rows)).toEqual(['docs', '  adr', '    015-data-retention-policy-docs.md', '    16 files, 2 folders not read'])
    expect(rows[3]).toMatchObject({ key: `u:${ADR}`, kind: 'fold', expanded: false, glyph: { text: '▸' } })
  })

  test('expanded: the untouched folders (collapsed) and files show at their depth; the folders never auto-expand', () => {
    const rows = treeRows(ctx([read('015-data-retention-policy-docs.md')]), open(`u:${ADR}`))
    expect(rows[3]).toMatchObject({ kind: 'fold', expanded: true, glyph: { text: '▾' } })
    const rest = rows.slice(4)
    expect(rest.slice(0, 2).map((r) => [r.label, r.kind, r.expanded, r.depth])).toEqual([
      ['drafts', 'dir', false, 2],
      ['superseded', 'dir', false, 2],
    ])
    expect(rest.slice(2).map((r) => r.label)).toEqual([...ADR_NAMES.filter((n) => !n.startsWith('015')), 'README.md'])
    expect(rest.every((r) => r.depth === 2)).toBe(true)
  })

  test('reading 003 moves it out of the fold and the count drops by one', () => {
    const rows = treeRows(ctx([read('015-data-retention-policy-docs.md'), read('003-doc-wiki-format.md')]), open())
    expect(labels(rows)).toEqual(['docs', '  adr', '    003-doc-wiki-format.md', '    015-data-retention-policy-docs.md', '    15 files, 2 folders not read'])
  })

  test('touched means read, searched, edited, committed, changed in git, in flight, or holding one; a listing alone is not', () => {
    const git: GitSnapshot = { root: P, branch: 'main', head: 'a', ahead: 0, behind: 0, files: new Map([[`${ADR}/002-monorepo.md`, { path: `${ADR}/002-monorepo.md`, letter: 'M', staged: false, added: 1, removed: 0, binary: false }]]) }
    const records = [
      read('015-data-retention-policy-docs.md'),
      ev({ kind: 'hit', path: `${ADR}/007-search.md` }),
      ev({ kind: 'edit', path: `${ADR}/005-auth.md`, tool: 'Edit', linesAdded: 1 }),
      ev({ kind: 'commit', path: `${ADR}/006-storage.md`, tool: 'git commit', source: 'gitScan', sha: 'abc1234' }),
      ev({ kind: 'listing', path: `${ADR}/016-retention.md`, tool: 'Bash:ls' }),
      ev({ kind: 'read', path: `${ADR}/superseded/000-old.md`, ranges: [[1, 1]], totalLines: 1 }),
    ]
    const rows = treeRows(ctx(records, { git, pending: new Map([[`${ADR}/009-sync.md`, 'read']]) }), open(`${ADR}/superseded`))
    const shown = labels(rows).map((l) => l.trim())
    for (const n of ['superseded', '000-old.md', '002-monorepo.md', '005-auth.md', '006-storage.md', '007-search.md', '009-sync.md', '015-data-retention-policy-docs.md']) expect(shown).toContain(n)
    expect(shown).not.toContain('016-retention.md')
    expect(shown[shown.length - 1]).toBe('11 files, 1 folder not read')
  })

  test('untracked files count as untouched until read: a folder of only new files folds, its files still say `new`', () => {
    const NOTES = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((n) => `${P}/notes/${n}`)
    const untracked = (p: string) => [p, { path: p, letter: '?', staged: false, added: 0, removed: 0, binary: false }] as const
    const git: GitSnapshot = { root: P, branch: 'main', head: 'a', ahead: 0, behind: 0, files: new Map([...NOTES, `${ADR}/drafts/017-draft.md`].map(untracked)) }
    const c = (records: LogRecord[]) => ctx(records, { git, projectFiles: [...fixture(P), ...NOTES] })
    // Nothing in notes/ read: the folder joins the root's fold; drafts/ stays in adr/'s fold.
    const rows = treeRows(c([read('015-data-retention-policy-docs.md')]), open())
    expect(labels(rows)).toEqual(['docs', '  adr', '    015-data-retention-policy-docs.md', '    16 files, 2 folders not read', '1 folder not read'])
    // notes/ opened by hand, one file read: the other four fold into one row; opened, each is labelled `new`.
    const r = (p: string) => ev({ kind: 'read', path: p, ranges: [[1, 1]], totalLines: 1 })
    const notes = treeRows(c([r(NOTES[0]!)]), { expanded: new Set([`${P}/notes`]), query: '', sort: 'recent' })
    expect(labels(notes)).toEqual(['notes', '  a.md', '  4 files not read', '1 folder not read'])
    const opened = treeRows(c([r(NOTES[0]!)]), { expanded: new Set([`${P}/notes`, `u:${P}/notes`]), query: '', sort: 'recent' })
    const quiet = opened.filter((x) => x.kind === 'file' && x.label !== 'a.md')
    expect(quiet.map((x) => x.label)).toEqual(['b.md', 'c.md', 'd.md', 'e.md'])
    for (const x of quiet) expect(x.meta.map((m) => m.text)).toContain('new')
  })

  test('singular forms, a zero part left out; a folder with nothing untouched has no fold row', () => {
    const files = [`${P}/a/x.ts`, `${P}/a/y.ts`, `${P}/b/z.ts`, `${P}/b/w.ts`, `${P}/b/sub/q.ts`]
    const c = (records: LogRecord[]) => ({ ...ctx(records), projectFiles: files })
    const r = (path: string) => ev({ kind: 'read', path, ranges: [[1, 1]], totalLines: 1 })
    const ui = { expanded: new Set([`${P}/a`, `${P}/b`]), query: '', sort: 'recent' as const }
    const rows = labels(treeRows(c([r(`${P}/a/x.ts`), r(`${P}/b/z.ts`)]), ui)).map((l) => l.trim())
    expect(rows).toEqual(['a', 'x.ts', '1 file not read', 'b', 'z.ts', '1 file, 1 folder not read'])
    const all = labels(treeRows(c([r(`${P}/a/x.ts`), r(`${P}/a/y.ts`), r(`${P}/b/z.ts`), r(`${P}/b/w.ts`)]), ui)).map((l) => l.trim())
    expect(all).toEqual(['a', 'x.ts', 'y.ts', 'b', 'w.ts', 'z.ts', '1 folder not read'])
  })

  test('a folder opened by hand with nothing touched inside lists its children directly', () => {
    const rows = treeRows(ctx([read('015-data-retention-policy-docs.md')]), open(`u:${ADR}`, `${ADR}/drafts`))
    const i = rows.findIndex((r) => r.label === 'drafts')
    expect(rows[i + 1]).toMatchObject({ label: '017-draft.md', kind: 'file', depth: 3 })
  })

  test('search bypasses the fold: a matching untouched file is shown', () => {
    const rows = treeRows(ctx([read('015-data-retention-policy-docs.md')]), { ...open(), query: '003' })
    expect(labels(rows).map((l) => l.trim())).toEqual(['docs', 'adr', '003-doc-wiki-format.md'])
  })

  test('l / Enter opens the fold, h closes it (like a plugin group)', () => {
    const c = ctx([read('015-data-retention-policy-docs.md')])
    const p = initialPanel()
    p.expanded = new Set([`${P}/docs`, ADR])
    const rows = () => treeRows(c, { expanded: p.expanded, query: '', sort: 'recent' })
    p.selected.tree = `u:${ADR}`
    expand(p, rows())
    expect(rows()[3]!.expanded).toBe(true)
    collapse(p, rows(), 10)
    expect(rows()[3]!.expanded).toBe(false)
    activate(p, rows()[3]!)
    expect(rows()[3]!.expanded).toBe(true)
  })
})

describe('the fold in the drawn panel', () => {
  const files = Object.fromEntries(fixture(CWD).map((p) => [p, '# x\n']))
  test('a click opens and closes the fold; follow reveals a read file but leaves the untouched folders collapsed', async ($, on) => {
    harness(on, files)
    host(on)
    const t = tools(on)
    await startSession($)
    const adr015 = `${CWD}/docs/adr/015-data-retention-policy-docs.md`
    await t.call($, { tool: 'Read', file_path: adr015 }, readResult(adr015, '# x\n'))
    const ui = await $.ui.mount(pane(60, 30))
    const text = async () => (await screen(ui)).map((l) => l.trimEnd())
    // Row anatomy: two gutter cells and a space, the depth-2 indent, the caret slot, then the icon slot (blank on a
    // fold row) before the label.
    expect((await text()).filter((l) => /not read/.test(l))).toEqual([`${' '.repeat(4 + 3 * 2)}▸ ${'   '}16 files, 2 folders not read`])
    await clickRow(ui, `u:${CWD}/docs/adr`)
    // A folder row: caret, then its folder icon, then the name.
    expect((await text()).some((l) => /▸ \S +drafts( |$)/.test(l))).toBe(true)
    expect((await text()).some((l) => /017-draft\.md/.test(l))).toBe(false)
    // A second read: auto-reveal opens nothing new.
    const adr003 = `${CWD}/docs/adr/003-doc-wiki-format.md`
    await t.call($, { tool: 'Read', file_path: adr003 }, readResult(adr003, '# x\n'))
    await ui.redraw()
    expect((await text()).some((l) => /▸ \S +drafts( |$)/.test(l))).toBe(true)
    expect((await text()).some((l) => /15 files, 2 folders not read/.test(l))).toBe(true)
    await clickRow(ui, `u:${CWD}/docs/adr`)
    expect((await clientLines(ui)).some((l) => l.id === `d:${CWD}/docs/adr/drafts`)).toBe(false)
  })
})
