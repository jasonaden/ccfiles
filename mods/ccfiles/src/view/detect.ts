// What `glyphs: auto` resolves to. Pure: the hook gathers the inputs (surface, environment,
// one `fc-list` run and a `~/Library/Fonts` listing, both local, after `session.start`'s `next(e)`) and asks here.
import { icon, type GlyphSet } from './icons.ts'

export type GlyphSetting = 'auto' | GlyphSet

export type GlyphInputs = {
  readonly setting: GlyphSetting
  /** The surface the pane draws on: `terminal`, `desktop`, `mobile`, `vscode`. */
  readonly surface: string
  /** SSH_CONNECTION or SSH_TTY is set: the font is the client machine's, out of reach. */
  readonly ssh: boolean
  readonly termProgram?: string
  /** `fc-list` found a font with FC_LIST_CODEPOINT; null/undefined = not run or failed. */
  readonly fcListHasGlyph?: boolean | null
  /** `~/Library/Fonts` holds a file named `*Nerd*`; null/undefined = not looked. */
  readonly libraryFontsHasNerd?: boolean | null
}

/** Terminals that draw the Nerd Font symbols with no Nerd Font installed. Lower-case. */
const SELF_DRAWING = ['ghostty', 'wezterm', 'kitty']

/**
 * The answer that needs no font probe, or null when it takes `fc-list` / the fonts folder: an explicit setting,
 * `plain` off the terminal, `nerd` over SSH or in a terminal that ships the symbols.
 */
export function glyphsWithoutProbe(i: Pick<GlyphInputs, 'setting' | 'surface' | 'ssh' | 'termProgram'>): GlyphSet | null {
  if (i.setting !== 'auto') return i.setting
  if (i.surface !== 'terminal') return 'plain'
  if (i.ssh) return 'nerd'
  if (i.termProgram && SELF_DRAWING.includes(i.termProgram.toLowerCase())) return 'nerd'
  return null
}

/** `glyphs: auto | nerd | plain` → the set rows draw with. Anything not found or failed → `plain`. */
export function chooseGlyphs(i: GlyphInputs): GlyphSet {
  const known = glyphsWithoutProbe(i)
  if (known !== null) return known
  if (i.fcListHasGlyph === true) return 'nerd'
  if (i.libraryFontsHasNerd === true) return 'nerd'
  return 'plain'
}

/** SSH_CONNECTION or SSH_TTY, non-empty. */
export function sshFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY)
}

/** The probe codepoint: our generic file icon (nf-md-file), in the nf-md range only Nerd Fonts v3 cover. */
export const FC_LIST_CODEPOINT = icon('file', 'nerd').codePointAt(0)!.toString(16)

/** `fc-list ':charset=<codepoint>'`: fonts that hold the glyph, one per line; none → empty output. */
export const FC_LIST_ARGV: readonly string[] = ['fc-list', `:charset=${FC_LIST_CODEPOINT}`]

/** fc-list's answer: any non-blank output from a successful run means a font has the glyph. */
export function parseFcList(stdout: string, exitCode = 0): boolean {
  return exitCode === 0 && stdout.trim() !== ''
}

/** Where the macOS fallback looks: `~/Library/Fonts`. */
export function libraryFontsDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/Library/Fonts`
}

/** The `*Nerd*` glob over that folder's file names (any case: macOS names are case-insensitive). */
export function hasNerdFontFile(names: readonly string[]): boolean {
  return names.some((n) => /nerd/i.test(n))
}
