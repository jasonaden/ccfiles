import { describe, expect, test } from 'claude-code/testing'
import { fmtDate, fmtSize, folderTimes, nextValueMode } from '../src/view/values.ts'
import { helpView, miniBar } from '../src/view/detail.ts'

describe('right column forms', () => {
  test('Σ cycles tokens → lines → date → size → tokens', () => {
    expect(nextValueMode('tokens')).toBe('lines')
    expect(nextValueMode('lines')).toBe('date')
    expect(nextValueMode('date')).toBe('size')
    expect(nextValueMode('size')).toBe('tokens')
  })
  test('date: time today, month and day this year, the year before that', () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime()
    expect(fmtDate(new Date(2026, 9, 9, 14, 2).getTime(), now)).toBe('14:02')
    expect(fmtDate(new Date(2026, 9, 8, 23, 59).getTime(), now)).toBe('Oct 8')
    expect(fmtDate(new Date(2025, 0, 3).getTime(), now)).toBe('Jan 3 2025')
  })
  test('size: bytes, then K/M/G with one decimal under 10', () => {
    expect(fmtSize(812)).toBe('812B')
    expect(fmtSize(12 * 1024)).toBe('12K')
    expect(fmtSize(1.4 * 1024 * 1024)).toBe('1.4M')
    expect(fmtSize(9.95 * 1024)).toBe('10K')
  })
})

describe('detail mini bar', () => {
  test('eighth blocks over 10 cells, framed, always 12 wide; a sliver is never empty, nearly all is never full', () => {
    expect(miniBar(0)).toBe('▕          ▏')
    expect(miniBar(1)).toBe('▕██████████▏')
    expect(miniBar(0.5)).toBe('▕█████     ▏')
    expect(miniBar(0.001)).toBe('▕▏         ▏')
    expect(miniBar(0.999)).toBe('▕█████████▉▏')
    for (const f of [0, 0.03, 0.26, 0.5, 0.74, 0.99, 1]) expect([...miniBar(f)].length).toBe(12)
  })
})

describe('help view notes', () => {
  const text = (o: Parameters<typeof helpView>[1]) => helpView(undefined, o).map((l) => l.map((s) => s.text).join('')).join('\n')
  test('says which keys need a click, and where colours come from in each palette mode', () => {
    expect(text({})).toContain('need a click in the list')
    expect(text({ palette: 'theme' })).toContain('follow your Claude Code theme')
    expect(text({ palette: 'hex' })).toContain("the viewer's own colours")
  })
})

describe('folder dates', () => {
  test('each folder takes its newest file\'s time; a folder listed with time 0 is replaced', () => {
    const info = new Map([
      ['/r/a/x.ts', { size: 1, mtimeMs: 100 }],
      ['/r/a/b/y.ts', { size: 1, mtimeMs: 300 }],
      ['/r/c/z.ts', { size: 1, mtimeMs: 50 }],
      ['/r/a', { size: 0, mtimeMs: 0 }],
    ])
    folderTimes(info, ['/r/a/x.ts', '/r/a/b/y.ts', '/r/c/z.ts'])
    expect(info.get('/r/a')!.mtimeMs).toBe(300)
    expect(info.get('/r/a/b')!.mtimeMs).toBe(300)
    expect(info.get('/r/c')!.mtimeMs).toBe(50)
    expect(info.get('/r')!.mtimeMs).toBe(300)
  })
})
