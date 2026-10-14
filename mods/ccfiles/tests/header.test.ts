import { describe, expect, test } from 'claude-code/testing'
import type { GitSnapshot } from '../src/git.ts'
import { branchRow, footerBlock, tabStrip, tabWidth } from '../src/view/header.ts'
import { cellWidth } from '../src/view/text.ts'

const txt = (ps: readonly { text: string }[]) => ps.map((p) => p.text).join('')

function snap(files: [string, string, number, number][], o: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: '/r',
    branch: 'main',
    head: 'abc',
    ahead: 4,
    behind: null,
    files: new Map(files.map(([path, letter, added, removed]) => [path, { path, letter: letter as never, staged: false, added, removed, binary: false }])),
    ...o,
  }
}

describe('branch row', () => {
  const git = snap([['/r/a', 'M', 19, 5], ['/r/b', '?', 0, 0], ['/r/c', 'D', 0, 7], ['/r/x', '!', 0, 0]])

  test('wide: branch, ahead, upstream left; line counts and per-state words right; never `?` for git state', () => {
    const r = branchRow(git, 80, { upstream: 'origin/main' })
    expect(txt(r.left)).toBe('⎇  main ↑4 origin/main')
    expect(txt(r.right)).toBe('+19 −12 · 1 new · 1 mod · 1 del')
    expect(txt(r.right)).not.toContain('?')
  })

  test('narrow: upstream drops, then the counts, then +N −N; ⎇ branch ↑N stays', () => {
    const at = (w: number) => branchRow(git, w, { upstream: 'origin/main' })
    expect(txt(at(50).left)).toBe('⎇  main ↑4')
    expect(txt(at(30).right)).toBe('+19 −12')
    expect(txt(at(12).left)).toBe('⎇  main ↑4')
    expect(at(12).right).toEqual([])
    for (const w of [12, 30, 50, 80]) {
      const r = at(w)
      expect(cellWidth(txt(r.left)) + (r.right.length ? 1 + cellWidth(txt(r.right)) : 0)).toBeLessThanOrEqual(Math.max(w, cellWidth(txt(r.left))))
    }
  })

  test('a clean tree says clean', () => {
    expect(txt(branchRow(snap([]), 60).right)).toBe('clean')
  })
})

describe('tab strip', () => {
  test('labels with counts on Touched and Instructions; search control at the end', () => {
    const s = tabStrip({ touched: 6, instructions: 4 }, 80, { full: '/ search', glyph: '/' })
    expect(s.tabs.map((t) => `${t.label}${t.count !== null ? ' ' + t.count : ''}`)).toEqual(['Tree', 'Touched 6', 'Instructions 4'])
    expect(s.search).toBe('/ search')
  })

  test('narrow: search shrinks to its glyph, then Instructions shortens; never wider than the strip', () => {
    for (const w of [33, 39, 41, 45, 60]) {
      const s = tabStrip({ touched: 12, instructions: 6 }, w, { full: '/ search', glyph: '/' })
      expect(s.tabs.reduce((n, t) => n + tabWidth(t), 0) + 1 + cellWidth(s.search)).toBeLessThanOrEqual(w)
    }
    expect(tabStrip({ touched: 12, instructions: 6 }, 39, { full: '/ search', glyph: '/' }).search).toBe('/')
    expect(tabStrip({ touched: 12, instructions: 6 }, 33, { full: '/ search', glyph: '/' }).tabs[2]!.label).toBe('Instr')
  })
})

describe('footer', () => {
  const chip = { full: '✓ committed a1c9e42', short: '✓ a1c9e42', color: 'commit' as const }
  const keys = [['j k', 'move'], ['d', 'detail'], ['g', 'help']] as const
  const f = (w: number, context: number | null = 62_000) => footerBlock({ who: 'main agent', context, files: 11_000, chip, keys }, w)
  test('wide: whose context and its exact size left, the files estimate right; the share for the bar; keys and the chip', () => {
    expect(txt(f(80).top.left)).toBe('main agent  62k in context (exact)')
    expect(txt(f(80).top.right)).toBe('≈11k from files')
    expect(Math.abs(f(80).share! - 11 / 62)).toBeLessThan(1e-9)
    expect(f(80).shareLabel).toBe('18% of context')
    expect(txt(f(80).bottom.left)).toBe('j k move · d detail · g help')
    expect(txt(f(80).bottom.right)).toBe('✓ committed a1c9e42')
  })
  test('narrow: the wording shortens, then who and files drop; the context figure never drops; keys drop from the end', () => {
    expect(txt(f(40).top.left)).toBe('main agent  62k exact')
    expect(txt(f(24).top.left)).toBe('62k exact')
    expect(txt(f(12).top.left)).toBe('62k exact')
    expect(txt(f(30).bottom.left)).toBe('j k move · d detail · g help')
    expect(txt(f(30).bottom.right)).toBe('')
    expect(txt(f(16).bottom.left)).toBe('j k move')
  })
  test('before any request: no context figure and no share', () => {
    expect(txt(f(80, null).top.left)).toBe('main agent  no request yet')
    expect(f(80, null).share).toBeNull()
  })
})
