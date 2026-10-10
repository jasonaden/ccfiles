import { describe, expect, test } from 'claude-code/testing'
import { fileIcon, icon, isPrivateUse, meterGlyph, type GlyphSet, type IconKind } from '../src/view/icons.ts'
import { cellWidth } from '../src/view/text.ts'

const KINDS: readonly IconKind[] = ['folder', 'folderOpen', 'repo', 'file', 'system', 'branch', 'caretClosed', 'caretOpen']
const NAMES = [
  'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.json', 'README.md', 'a.mdx', 'a.yaml', 'a.yml', 'Cargo.toml',
  'a.sh', 'a.bash', 'a.zsh', 'a.py', 'a.go', 'a.rs', 'a.rb', 'A.java', 'a.kt', 'a.swift', 'a.c', 'a.h', 'a.cpp',
  'a.css', 'a.scss', 'index.html', 'a.svg', 'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.sql', 'Cargo.lock', 'yarn.lock',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', 'Dockerfile', 'Dockerfile.dev', 'Makefile',
  '.gitignore', 'LICENSE', 'LICENSE.md', '.env', '.env.local', 'notes.unknownext', 'noext',
]
const FRACTIONS = Array.from({ length: 101 }, (_, i) => i / 100)

function nerdGlyphs(): string[] {
  return [
    ...KINDS.map((k) => icon(k, 'nerd')),
    ...NAMES.map((n) => fileIcon(n, 'nerd').g),
    ...FRACTIONS.map((f) => meterGlyph(f, 'nerd')),
  ]
}

function plainGlyphs(): string[] {
  return [
    ...KINDS.map((k) => icon(k, 'plain')),
    ...NAMES.map((n) => fileIcon(n, 'plain').g),
    ...FRACTIONS.map((f) => meterGlyph(f, 'plain')),
  ]
}

describe('nerd glyphs', () => {
  test('every nerd glyph is one code point in a Private Use Area', () => {
    for (const g of nerdGlyphs()) {
      const cps = [...g].map((ch) => ch.codePointAt(0)!)
      expect(cps.length).toBe(1)
      expect(isPrivateUse(cps[0]!)).toBe(true)
    }
  })

  test('isPrivateUse covers the BMP block and planes 15–16 only', () => {
    expect(isPrivateUse(0xe000)).toBe(true)
    expect(isPrivateUse(0xf8ff)).toBe(true)
    expect(isPrivateUse(0xf0214)).toBe(true)
    expect(isPrivateUse(0x10fffd)).toBe(true)
    expect(isPrivateUse(0xdfff)).toBe(false)
    expect(isPrivateUse(0xf900)).toBe(false)
    expect(isPrivateUse('a'.codePointAt(0)!)).toBe(false)
    expect(isPrivateUse('●'.codePointAt(0)!)).toBe(false)
  })
})

describe('file icons', () => {
  const nerd = (n: string) => fileIcon(n, 'nerd')
  const generic = nerd('noext')

  test('known names win over their extension', () => {
    expect(nerd('package.json').g).not.toBe(nerd('other.json').g)
    expect(nerd('tsconfig.json').g).not.toBe(nerd('other.json').g)
    expect(nerd('Dockerfile')).not.toEqual(generic)
    expect(nerd('Makefile')).not.toEqual(generic)
    expect(nerd('.gitignore')).not.toEqual(generic)
    expect(nerd('LICENSE')).not.toEqual(generic)
  })

  test('name and extension matching ignores case, and name variants share the base icon', () => {
    expect(nerd('FOO.MD')).toEqual(nerd('foo.md'))
    expect(nerd('foo.ts')).toEqual(nerd('bar.TS'))
    expect(nerd('dockerfile')).toEqual(nerd('Dockerfile'))
    expect(nerd('Dockerfile.dev')).toEqual(nerd('Dockerfile'))
    expect(nerd('LICENSE.md')).toEqual(nerd('LICENSE'))
    expect(nerd('.env.local')).toEqual(nerd('.env'))
  })

  test('types carry a language colour; different languages differ', () => {
    expect(nerd('foo.ts').c).toMatch(/^#[0-9a-f]{6}$/)
    expect(nerd('foo.ts').g).not.toBe(nerd('foo.py').g)
    expect(nerd('foo.ts').c).not.toBe(nerd('foo.py').c)
  })

  test('unknown names fall back to the generic file icon with no colour', () => {
    expect(nerd('notes.unknownext')).toEqual({ g: icon('file', 'nerd') })
    expect(nerd('noext')).toEqual({ g: icon('file', 'nerd') })
    expect(nerd('.bashrc')).toEqual({ g: icon('file', 'nerd') })
  })
})

describe('plain glyphs', () => {
  test('never emit a Private Use Area code point', () => {
    for (const g of plainGlyphs()) for (const ch of g) expect(isPrivateUse(ch.codePointAt(0)!)).toBe(false)
  })

  test('every file is the generic dot', () => {
    for (const n of NAMES) expect(fileIcon(n, 'plain')).toEqual({ g: '·' })
  })
})

describe('meterGlyph', () => {
  const sets: readonly GlyphSet[] = ['plain', 'nerd']

  test('plain: 5 steps, empty only at 0, full only at 1', () => {
    expect(meterGlyph(0, 'plain')).toBe('○')
    expect(meterGlyph(0.001, 'plain')).toBe('◔')
    expect(meterGlyph(0.5, 'plain')).toBe('◑')
    expect(meterGlyph(0.999, 'plain')).toBe('◕')
    expect(meterGlyph(1, 'plain')).toBe('●')
  })

  test('nerd: 8 slices, slice 8 only at 1', () => {
    const full = meterGlyph(1, 'nerd')
    const slices = new Set(FRACTIONS.filter((f) => f > 0 && f < 1).map((f) => meterGlyph(f, 'nerd')))
    expect(slices.size).toBe(7)
    expect(slices.has(full)).toBe(false)
    expect(slices.has(meterGlyph(0, 'nerd'))).toBe(false)
    expect(meterGlyph(0.001, 'nerd')).toBe(meterGlyph(0.1, 'nerd'))
    expect(meterGlyph(0.999, 'nerd')).toBe(meterGlyph(0.9, 'nerd'))
  })

  test('steps never go down as coverage grows, and out-of-range input clamps', () => {
    for (const set of sets) {
      const order = FRACTIONS.map((f) => meterGlyph(f, set))
      const distinct = order.filter((g, i) => i === 0 || g !== order[i - 1])
      expect(new Set(distinct).size).toBe(distinct.length)
      expect(meterGlyph(-1, set)).toBe(meterGlyph(0, set))
      expect(meterGlyph(Number.NaN, set)).toBe(meterGlyph(0, set))
      expect(meterGlyph(2, set)).toBe(meterGlyph(1, set))
    }
  })
})

describe('icon width', () => {
  test('a row with nerd glyphs is 1 cell per glyph, whatever the glyph', () => {
    for (const g of nerdGlyphs()) expect(cellWidth(`${g} name`)).toBe(6)
    const row = `${icon('caretOpen', 'nerd')} ${icon('folderOpen', 'nerd')} src ${meterGlyph(0.4, 'nerd')} ${fileIcon('a.ts', 'nerd').g} a.ts`
    expect(cellWidth(row)).toBe([...row].length)
  })

  test('plain icons are 1 cell except the system ⚡, which is 2', () => {
    for (const k of KINDS) expect(cellWidth(icon(k, 'plain'))).toBe(k === 'system' ? 2 : 1)
  })
})
