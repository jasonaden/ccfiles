import { describe, expect, test } from 'claude-code/testing'
import { cellWidth, fillColumns, fitRow, fmtLines, splitAt, truncateMiddle, type Segment } from '../src/view/text.ts'

const text = (segs: readonly Segment[]) => segs.map((s) => s.text).join('')

describe('cell widths', () => {
  test('ASCII and box glyphs are one cell, ⚡ and CJK are two, combining marks none', () => {
    expect(cellWidth('abc')).toBe(3)
    expect(cellWidth('●◐◌◇✎↩⟳▸▾')).toBe(9)
    expect(cellWidth('⚡')).toBe(2)
    expect(cellWidth('漢字')).toBe(4)
    expect(cellWidth('é')).toBe(1)
  })

  test('truncateMiddle keeps both ends and fits the width', () => {
    const t = truncateMiddle('src/components/very/long/file-name.ts', 16)
    expect(cellWidth(t)).toBe(16)
    expect(t).toMatch(/^src\/.*….*name\.ts$/)
    expect(truncateMiddle('short.ts', 16)).toBe('short.ts')
  })
})

describe('compact numbers', () => {
  test('approximate line counts', () => {
    expect(fmtLines(40)).toBe('40')
    expect(fmtLines(1323)).toBe('1.3k')
    expect(fmtLines(12_400)).toBe('12k')
    expect(fmtLines(null)).toBe('?')
  })
})

describe('row fill', () => {
  test('fill width = round(coverage × width)', () => {
    expect(fillColumns(0.15, 60)).toBe(9)
    expect(fillColumns(0.26, 47)).toBe(12)
    expect(fillColumns(1, 50)).toBe(50)
    expect(fillColumns(0, 50)).toBe(0)
    expect(fillColumns(null, 50)).toBe(0)
  })

  test('fitRow pads left and right parts to exactly the width', () => {
    const row = fitRow([{ text: '● big.md' }], [{ text: '1.3k ≈3.8k tok' }], 40)
    expect(cellWidth(text(row))).toBe(40)
    expect(text(row)).toMatch(/^● big\.md +1\.3k ≈3\.8k tok$/)
  })

  test('fitRow truncates the name, never the meta', () => {
    const row = fitRow([{ text: '● a-very-long-file-name-that-does-not-fit.md' }], [{ text: '≈3.8k tok' }], 30)
    expect(cellWidth(text(row))).toBe(30)
    expect(text(row).endsWith(' ≈3.8k tok')).toBe(true)
  })

  test('splitAt marks the first n cells and keeps every character', () => {
    const row = fitRow([{ text: 'ab', fg: 'x' }, { text: 'cdef' }], [{ text: 'z' }], 10)
    const split = splitAt(row, 3, 'FILL')
    expect(text(split)).toBe(text(row))
    expect(cellWidth(split.filter((s) => s.bg === 'FILL').map((s) => s.text).join(''))).toBe(3)
    expect(split[0]).toEqual({ text: 'ab', fg: 'x', bg: 'FILL' })
  })

  test('a wide glyph on the boundary stays whole (±1 column)', () => {
    const split = splitAt([{ text: 'a⚡b' }], 2, 'F')
    const filled = cellWidth(split.filter((s) => s.bg === 'F').map((s) => s.text).join(''))
    expect(Math.abs(filled - 2)).toBeLessThan(2)
  })
})
