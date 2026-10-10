// `glyphs: auto` detection as a pure decision.
import { describe, expect, test } from 'claude-code/testing'
import { chooseGlyphs, FC_LIST_ARGV, FC_LIST_CODEPOINT, glyphsWithoutProbe, hasNerdFontFile, libraryFontsDir, parseFcList, sshFromEnv, type GlyphInputs } from '../src/view/detect.ts'
import { fileIcon, icon, isPrivateUse } from '../src/view/icons.ts'

const LOCAL: GlyphInputs = { setting: 'auto', surface: 'terminal', ssh: false }
const FC_LINE = '/Users/j/Library/Fonts/JetBrainsMonoNerdFontMono-Regular.ttf: JetBrainsMono Nerd Font Mono:style=Regular\n'

describe('glyphs: auto', () => {
  test('an explicit setting wins over everything', () => {
    expect(chooseGlyphs({ ...LOCAL, setting: 'plain', ssh: true, termProgram: 'ghostty', fcListHasGlyph: true })).toBe('plain')
    expect(chooseGlyphs({ ...LOCAL, setting: 'nerd', surface: 'desktop' })).toBe('nerd')
  })
  test('the desktop surface draws plain, even over SSH or with a Nerd Font found', () => {
    expect(chooseGlyphs({ ...LOCAL, surface: 'desktop', ssh: true, fcListHasGlyph: true, libraryFontsHasNerd: true })).toBe('plain')
  })
  test('SSH → nerd (the font is the client\'s)', () => {
    expect(chooseGlyphs({ ...LOCAL, ssh: true, fcListHasGlyph: false })).toBe('nerd')
  })
  test('Ghostty, WezTerm and kitty ship the symbols: nerd, whatever the case', () => {
    for (const t of ['ghostty', 'WezTerm', 'kitty', 'Ghostty', 'WEZTERM']) expect(chooseGlyphs({ ...LOCAL, termProgram: t })).toBe('nerd')
    expect(chooseGlyphs({ ...LOCAL, termProgram: 'Apple_Terminal' })).toBe('plain')
    expect(chooseGlyphs({ ...LOCAL, termProgram: 'iTerm.app' })).toBe('plain')
  })
  test('fc-list finding the glyph → nerd; else the ~/Library/Fonts glob; else plain', () => {
    expect(chooseGlyphs({ ...LOCAL, fcListHasGlyph: true })).toBe('nerd')
    expect(chooseGlyphs({ ...LOCAL, fcListHasGlyph: false, libraryFontsHasNerd: true })).toBe('nerd')
    expect(chooseGlyphs({ ...LOCAL, fcListHasGlyph: null, libraryFontsHasNerd: true })).toBe('nerd')
    expect(chooseGlyphs({ ...LOCAL, fcListHasGlyph: false, libraryFontsHasNerd: false })).toBe('plain')
  })
  test('nothing found, or the probes failed or never ran → plain', () => {
    expect(chooseGlyphs(LOCAL)).toBe('plain')
    expect(chooseGlyphs({ ...LOCAL, fcListHasGlyph: null, libraryFontsHasNerd: null })).toBe('plain')
  })
  test('the probes are needed only when nothing else decides', () => {
    expect(glyphsWithoutProbe(LOCAL)).toBeNull()
    expect(glyphsWithoutProbe({ ...LOCAL, termProgram: 'Apple_Terminal' })).toBeNull()
    expect(glyphsWithoutProbe({ ...LOCAL, ssh: true })).toBe('nerd')
    expect(glyphsWithoutProbe({ ...LOCAL, surface: 'desktop' })).toBe('plain')
    expect(glyphsWithoutProbe({ ...LOCAL, setting: 'nerd' })).toBe('nerd')
  })
})

describe('probe inputs', () => {
  test('fc-list asks for a codepoint the nerd icon table actually draws, as bare hex', () => {
    expect(FC_LIST_ARGV).toEqual(['fc-list', `:charset=${FC_LIST_CODEPOINT}`])
    expect(FC_LIST_CODEPOINT).toMatch(/^[0-9a-f]+$/)
    const cp = parseInt(FC_LIST_CODEPOINT, 16)
    expect(isPrivateUse(cp)).toBe(true)
    expect(fileIcon('notes.unknownext', 'nerd').g.codePointAt(0)).toBe(cp)
    expect(icon('file', 'nerd')).toBe(String.fromCodePoint(cp))
  })
  test('fc-list output: a font line → true; empty output or a failed run → false', () => {
    expect(parseFcList(FC_LINE)).toBe(true)
    expect(parseFcList('')).toBe(false)
    expect(parseFcList('  \n')).toBe(false)
    expect(parseFcList(FC_LINE, 1)).toBe(false)
  })
  test('SSH_CONNECTION or SSH_TTY marks an SSH session; empty values don\'t', () => {
    expect(sshFromEnv({ SSH_CONNECTION: '10.0.0.2 52144 10.0.0.1 22' })).toBe(true)
    expect(sshFromEnv({ SSH_TTY: '/dev/ttys003' })).toBe(true)
    expect(sshFromEnv({ SSH_TTY: '' })).toBe(false)
    expect(sshFromEnv({ TERM_PROGRAM: 'ghostty' })).toBe(false)
  })
  test('the ~/Library/Fonts glob matches *Nerd* file names', () => {
    expect(libraryFontsDir('/Users/j/')).toBe('/Users/j/Library/Fonts')
    expect(hasNerdFontFile(['Inter.ttf', 'JetBrainsMonoNerdFontMono-Regular.ttf'])).toBe(true)
    expect(hasNerdFontFile(['Hack Regular Nerd Font Complete.ttf'])).toBe(true)
    expect(hasNerdFontFile(['Inter.ttf', 'Menlo.ttc'])).toBe(false)
    expect(hasNerdFontFile([])).toBe(false)
  })
})
