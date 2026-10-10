import { describe, expect, test } from 'claude-code/testing'
import { columnWidths, fitFor, layoutRow, layoutWindow, MIN_NAME, type RowParts } from '../src/view/anatomy.ts'
import { cellWidth } from '../src/view/text.ts'

const row = (o: Omit<Partial<RowParts>, 'name'> & { name: string }): RowParts => ({
  gutter: null,
  badge: null,
  depth: 0,
  caret: null,
  icon: { text: '·' },
  marks: [],
  git: [],
  value: null,
  ...o,
  name: { text: o.name },
})
const text = (r: RowParts, w: number, rows: RowParts[] = [r]) => layoutWindow(rows, w)[rows.indexOf(r)]!.map((s) => s.text).join('')

describe('row anatomy', () => {
  const rows = [
    row({ name: 'docs', caret: { text: '▾' }, icon: { text: '■' }, value: { text: '≈2k' } }),
    row({ name: '015-data-retention-policy-docs.md', depth: 1, gutter: { text: '◑' }, value: { text: '≈809' } }),
    row({ name: 'federated.ts', depth: 1, gutter: { text: '●' }, marks: [{ text: '✎' }], git: [{ text: 'new' }], value: { text: '≈1.2k' } }),
    row({ name: 'retriever.ts', depth: 1, git: [{ text: '+19' }, { text: '−5' }] }),
  ]

  test('every row is exactly the pane width', () => {
    for (const w of [39, 47, 60, 100]) for (const r of rows) expect(cellWidth(text(r, w, rows))).toBe(w)
  })

  test('the gutter is fixed at columns 0-1 at every depth; names start where their depth says', () => {
    const lines = rows.map((r) => text(r, 80, rows))
    expect(lines[1]!.startsWith('◑   ')).toBe(true)
    expect(lines[2]!.startsWith('●   ')).toBe(true)
    // gutter (state, space, badge, space) + indent 3·depth + caret slot 2 + icon slot 3
    expect(lines[0]!.indexOf('docs')).toBe(9)
    expect(lines[2]!.indexOf('federated.ts')).toBe(12)
    expect(lines[3]!.indexOf('retriever.ts')).toBe(12)
  })

  test('git meta and values end at the same columns down the window', () => {
    const lines = rows.map((r) => text(r, 80, rows))
    const valueEnd = (l: string) => l.trimEnd().length
    expect(new Set(lines.filter((_, i) => rows[i]!.value).map(valueEnd)).size).toBe(1)
    // git column right edge: the value column (5 wide + its space) sits to its right
    expect(lines[2]!.lastIndexOf('new') + 3).toBe(lines[3]!.lastIndexOf('−5') + 2)
  })

  test('marks follow the name and stay when the name truncates', () => {
    const r = row({ name: 'a-very-long-file-name-that-will-not-fit.ts', gutter: { text: '●' }, marks: [{ text: '✎' }, { text: '↩2' }], value: { text: '≈12k' } })
    const l = text(r, 39)
    expect(l).toContain('… ✎ ↩2')
    expect(cellWidth(l)).toBe(39)
  })

  test('a two-cell gutter glyph takes the state cell and its space; the badge keeps its cell; the row keeps its width', () => {
    const r = row({ name: 'CLAUDE.md', gutter: { text: '⚡' }, badge: { text: 'Z' } })
    const l = text(r, 50)
    expect(l.startsWith('⚡Z ')).toBe(true)
    expect(cellWidth(l)).toBe(50)
  })

  test('a Private Use Area icon counts as 1 cell and never changes row width', () => {
    const nerd = row({ name: 'index.ts', icon: { text: '\u{E628}' }, value: { text: '≈1k' } })
    const plane15 = row({ name: 'index.ts', icon: { text: '\u{F0219}' }, value: { text: '≈1k' } })
    const plain = row({ name: 'index.ts', icon: { text: '·' }, value: { text: '≈1k' } })
    for (const w of [39, 60, 100]) {
      expect(cellWidth(text(nerd, w))).toBe(w)
      expect(cellWidth(text(plane15, w))).toBe(w)
      expect(text(nerd, w).indexOf('index.ts')).toBe(text(plain, w).indexOf('index.ts'))
    }
  })
})

describe('narrow panels', () => {
  const deep = [row({ name: 'retriever-implementation.ts', depth: 4, git: [{ text: '+19' }, { text: '−5' }], value: { text: '≈1.2k' } })]

  test('at 52+ columns nothing drops', () => {
    expect(fitFor(deep, 52)).toEqual({ icons: true, git: 'full' })
  })

  test('below 52: the icon drops first, then git shortens, then it goes; the name keeps 12 cells', () => {
    const at = (depth: number, w: number) => fitFor([{ ...deep[0]!, depth }], w)
    expect(at(2, 51)).toEqual({ icons: false, git: 'full' })
    expect(at(3, 39)).toEqual({ icons: false, git: 'short' })
    expect(at(4, 39)).toEqual({ icons: false, git: 'none' })
    for (const depth of [2, 3, 4])
      for (const w of [39, 41, 44, 47, 51]) {
        const rows = [{ ...deep[0]!, depth }]
        const l = text(rows[0]!, w, rows)
        expect(cellWidth(l)).toBe(w)
        const name = l.slice(l.indexOf('retr')).split(' ')[0]!
        expect(cellWidth(name)).toBeGreaterThanOrEqual(MIN_NAME)
      }
  })

  test('short git keeps the first figure only', () => {
    const r = row({ name: 'x.ts', git: [{ text: '+19' }, { text: '−5' }] })
    expect(layoutRow(r, 39, columnWidths([r], 'short'), { icons: false, git: 'short' }).map((s) => s.text).join('')).toContain('+19')
    expect(layoutRow(r, 39, columnWidths([r], 'short'), { icons: false, git: 'short' }).map((s) => s.text).join('')).not.toContain('−5')
  })
})

describe('width never drifts', () => {
  test('a two-cell icon on the clip edge still leaves the row exactly the pane width, at any depth', () => {
    for (let width = 20; width < 70; width++)
      for (let depth = 0; depth < 25; depth++) {
        const r = row({ name: 'CLAUDE.md', depth, icon: { text: '⚡' }, gutter: { text: '●' }, value: { text: '≈26' } })
        expect([width, depth, cellWidth(text(r, width))]).toEqual([width, depth, width])
      }
  })
})
