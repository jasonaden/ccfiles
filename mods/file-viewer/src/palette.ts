// Viewer palette: muted dark and light defaults, user overrides parsed from
// a flat JSON config, theme resolution, and the color math the
// contrast tests use. State is never shown by color alone; glyphs carry it too.

export type Variant = 'dark' | 'light'

export const COLOR_KEYS = [
  'read', 'search', 'edit', 'commit', 'instruction', 'pending', 'error',
  'git.A', 'git.M', 'git.D', 'git.R', 'git.untracked', 'git.ignored',
  'added', 'removed', 'muted', 'accent', 'selection', 'text', 'fill', 'fill.edit', 'fill.commit',
] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

export type Palette = {
  readonly variant: Variant
  /**
   * '#rrggbb' per key. `text` = file names; `muted` = untouched rows and meta; `selection` = selected-row
   * background; `fill`, `fill.edit`, `fill.commit` = the tint sources of the read fill by row state (C1).
   */
  readonly colors: Readonly<Record<ColorKey, string>>
  /** 0..1: how far a fill tint is pulled toward `fillToward`; 1 = no tint. */
  readonly fillDarkness: number
  /** What a fill tint is pulled toward: the background in truecolor, black (dark) or white (light) in 256 colours. */
  readonly fillToward: string
  /**
   * The background the variant is drawn on, '#rrggbb': what fills, bands and contrast are measured against. The
   * panel paints it only when `paint` is set (the dark variant uses the terminal's own background).
   */
  readonly background: string
  /** Paint `background` under the panel (light: a light panel over a dark terminal); dark leaves it unpainted. */
  readonly paint: boolean
  /** The colour depth Claude Code draws at: which cells `readableOn` must keep readable. */
  readonly depth: ColorDepth
}

/** How many colours Claude Code draws with: 24-bit, the xterm-256 cube, or none (NO_COLOR). */
export type ColorDepth = 'truecolor' | '256' | 'none'

/** The variables Claude Code 2.1.295 picks its colour depth from. */
export type ColorEnv = Partial<Record<'NO_COLOR' | 'TERM' | 'COLORTERM' | 'TMUX' | 'CLAUDE_CODE_TMUX_TRUECOLOR', string>>

const TRUECOLOR_TERM = /(^|-)(ghostty|kitty|wezterm|alacritty|foot|contour|rio)(-|$)/

/**
 * The colour depth Claude Code 2.1.295 draws at (mods get no API for it): none under NO_COLOR or TERM=dumb;
 * truecolor for COLORTERM truecolor/24bit or a truecolor terminal, except inside tmux, where Claude Code
 * clamps to 256 colours unless CLAUDE_CODE_TMUX_TRUECOLOR is set (tmux.conf alone does not change it);
 * else 256 colours.
 */
export function colorDepth(env: ColorEnv): ColorDepth {
  if (env.NO_COLOR || env.TERM === 'dumb') return 'none'
  const rgb = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || TRUECOLOR_TERM.test(env.TERM ?? '')
  if (!rgb || (env.TMUX && !env.CLAUDE_CODE_TMUX_TRUECOLOR)) return '256'
  return 'truecolor'
}

/** What a row's read fill is tinted by: read (ice blue), edited (rose), committed (gold). */
export type FillTone = 'read' | 'edit' | 'commit'

// Fill tints (C1). Inside tmux Claude Code draws 256 colours, rounding each channel with round(v / 51) onto
// the xterm cube: a muted tint just above the background lands on cube 59, a flat light grey. So the dark
// tints keep their two minor channels ≤ 25 and land on navy 17, maroon 52 and olive 58 there, and stay dark
// muted tints in truecolor. The selection is a pure grey, which maps onto the grey ramp, not cube 59.
const DARK: Palette = {
  variant: 'dark',
  background: '#262626',
  paint: false,
  depth: '256',
  fillDarkness: 0.75,
  fillToward: '#000000',
  colors: {
    read: '#8fb1d3', // steel blue
    search: '#8fb8b8',
    edit: '#db9aad', // dusty rose
    commit: '#c4c27c', // muted straw yellow
    instruction: '#aea8d4',
    pending: '#a8aab2',
    error: '#ea9c9c',
    'git.A': '#93bf9a',
    'git.M': '#cdb57f',
    'git.D': '#e09a9a',
    'git.R': '#8fb3d9',
    'git.untracked': '#a8b5a0',
    'git.ignored': '#a3a5ac',
    added: '#93bf9a',
    removed: '#e09a9a',
    muted: '#a6a8b0',
    accent: '#9fc0d8',
    selection: '#3a3a3a',
    text: '#d4d6dc',
    fill: '#5058c0', // → #141630 ice-blue tint
    'fill.edit': '#b84860', // → #2e1218 rose
    'fill.commit': '#a09830', // → #28260c gold
  },
}

// Light foregrounds keep every channel ≤ 76: inside tmux each rounds to 0 or 95, so the 256-colour cells stay
// dark enough for 4.5:1 on white and on the tints (mid tones like #2f5f8f round up to #5f87af and fail).
const LIGHT: Palette = {
  variant: 'light',
  background: '#ffffff',
  paint: true,
  depth: '256',
  fillDarkness: 0.8,
  fillToward: '#ffffff',
  colors: {
    read: '#0a2e4c',
    search: '#0e3b3b',
    edit: '#48101a',
    commit: '#4a4a10',
    instruction: '#301848',
    pending: '#444444',
    error: '#4c0a0a',
    'git.A': '#104818',
    'git.M': '#483c08',
    'git.D': '#4c0c0c',
    'git.R': '#0a2e4c',
    'git.untracked': '#284020',
    'git.ignored': '#4c4c4c',
    added: '#104818',
    removed: '#4c0c0c',
    muted: '#555555',
    accent: '#0c304c',
    selection: '#e4e4e4',
    text: '#1f1f1f',
    fill: '#1e69e6', // → #d2e1fa
    'fill.edit': '#e65078', // → #fadce4
    'fill.commit': '#c8be00', // → #f4f2cc
  },
}

/**
 * Truecolor values: a step more saturated than the 256-colour set, which keeps its cube-safe
 * values above. `muted` recedes on purpose; it is held to 3:1, not 4.5:1. The selection is cool.
 */
const DARK_TRUE: Partial<Record<ColorKey, string>> = {
  text: '#dcdfe4',
  muted: '#7f8794',
  accent: '#6fa8dc',
  read: '#7cc0e8', // ice blue
  search: '#8fcfc4',
  edit: '#ec8fab', // rose
  commit: '#d6cd62', // gold, ≥ 30° from orange
  instruction: '#b3a6ec',
  'git.M': '#dcb862',
  'git.A': '#8cc085',
  'git.untracked': '#8cc085',
  added: '#8cc085',
  'git.D': '#e0787f',
  removed: '#e0787f',
  'git.R': '#6cb0e0',
  'git.ignored': '#7f8794',
  selection: '#3b4252',
}

/** Light truecolor values: the dark set's hues, dark enough for 4.5:1 on white. */
const LIGHT_TRUE: Partial<Record<ColorKey, string>> = {
  text: '#24292f',
  muted: '#6b7280',
  accent: '#1d5fa8',
  read: '#1268a8',
  search: '#0f6f68',
  edit: '#b0285c',
  commit: '#6f6800',
  instruction: '#6a45c2',
  pending: '#57606a',
  error: '#b42318',
  'git.M': '#8a5a00',
  'git.A': '#26782f',
  'git.untracked': '#26782f',
  added: '#26782f',
  'git.D': '#c0303a',
  removed: '#c0303a',
  'git.R': '#1f66b0',
  'git.ignored': '#6b7280',
  selection: '#e3e8ef',
}

/** Keys held to 3:1 instead of 4.5:1: they recede by design (untouched and ignored rows). */
export const RECEDING: readonly ColorKey[] = ['muted', 'git.ignored']

/** In truecolor a fill is a subtle tint: this share of the state colour over the panel background. */
export const TRUECOLOR_TINT = 0.3

/**
 * The variant's defaults at a colour depth. 256 colours (and none): the saturated tints above, which
 * keep their hue in the xterm cube. Truecolor: ~30% of the state colour blended over the panel background.
 */
export function defaultPalette(variant: Variant, depth: ColorDepth = '256'): Palette {
  const base = variant === 'light' ? LIGHT : DARK
  if (depth !== 'truecolor') return depth === base.depth ? base : { ...base, depth }
  const colors = { ...base.colors, ...(variant === 'light' ? LIGHT_TRUE : DARK_TRUE) }
  return { ...base, colors, depth, fillDarkness: 1 - TRUECOLOR_TINT, fillToward: base.background }
}

const FILL_SOURCE: Record<FillTone, ColorKey> = { read: 'fill', edit: 'fill.edit', commit: 'fill.commit' }

/** The background of a row's filled part: its state's tint source pulled toward `fillToward` by `fillDarkness`. */
export function fillBackground(p: Palette, tone: FillTone = 'read'): string {
  return mix(p.colors[FILL_SOURCE[tone]], p.fillToward, p.fillDarkness)
}

/**
 * The fill of a row out of context: between the panel background and the live fill, less prominent than
 * the live fill, with muted text readable on it. Truecolor: half-way between the two. 256 colours: a half-way mix
 * rounds onto cube 59 (#5f5f5f), brighter than the live navy/maroon/olive, or onto the white background in the
 * light theme. So the dim fill is the xterm cell nearest the midpoint of the two cells Claude Code draws (live
 * fill and background) that differs from both, looks closer to the background than the live fill (ΔE; the dark
 * fills differ from #262626 by colour more than by luminance), keeps the live fill's hue or is grey, and keeps
 * `muted` at 4.5:1. No navy/maroon/olive cell lies nearer #262626 than 17/52/58, so the defaults dim to
 * near-background greys: dark 234 #1c1c1c (read, edit) and 237 #3a3a3a (commit) on 235 #262626; light 255
 * #eeeeee (read, edit, commit) on white. A live fill drawn as the background (light at `fill.darkness` 0.9)
 * leaves nothing to dim: the dim fill is drawn as the background too.
 */
export function dimFillBackground(p: Palette, tone: FillTone = 'read'): string {
  const live = fillBackground(p, tone)
  const half = mix(live, p.background, 0.5)
  if (p.depth === 'truecolor') return half
  const liveCell = quantize256(live).hex
  const bgCell = quantize256(p.background).hex
  if (liveCell === bgCell) return half
  const mutedCell = quantize256(p.colors.muted).hex
  const target = mix(liveCell, bgCell, 0.5)
  const reach = deltaE(liveCell, bgCell)
  // A cell no closer to the background than the live fill only wins when no closer one exists (an override
  // whose live fill is a cell next to the background): it still differs from both.
  let best: { input: string; d: number } | null = null
  for (const [input, cell] of cellInputs()) {
    if (cell === liveCell || cell === bgCell) continue
    if (!isGrey(cell) && hueDistance(hue(cell), hue(liveCell)) > 30) continue
    if (contrastRatio(p.colors.muted, input) < 4.5 || contrastRatio(mutedCell, cell) < 4.5) continue
    const d = (deltaE(cell, bgCell) < reach ? 0 : 1e6) + deltaE(cell, target)
    if (!best || d < best.d) best = { input, d }
  }
  return best?.input ?? half
}

const isGrey = (hex: string) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7)
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

let inputs: Map<string, string> | null = null

/** Every cell `quantize256` can draw, as input colour → cell, the input being the colour nearest the cell that draws it. */
function cellInputs(): Map<string, string> {
  if (inputs) return inputs
  const out = new Map<string, [string, number]>()
  const keep = (input: string, d: number) => {
    const cell = quantize256(input).hex
    const prev = out.get(cell)
    if (!prev || d < prev[1]) out.set(cell, [input, d])
  }
  const hex2 = (v: number) => v.toString(16).padStart(2, '0')
  for (let v = 0; v < 256; v++) {
    const grey = '#' + hex2(v).repeat(3)
    keep(grey, Math.abs(v - rgb(quantize256(grey).hex)[0]))
  }
  // Per cube level, the channel value inside its rounding range nearest the level itself.
  const level = CUBE.map((c, q) => Math.min(Math.max(c, Math.ceil(q * 51 - 25.5)), Math.floor(q * 51 + 25.5)))
  for (const r of level) for (const g of level) for (const b of level) if (r !== g || g !== b) keep(`#${hex2(r)}${hex2(g)}${hex2(b)}`, 0)
  inputs = new Map([...out].map(([cell, [input]]) => [input, cell]))
  return inputs
}

const CUBE = [0, 95, 135, 175, 215, 255]

/**
 * The xterm-256 cell Claude Code draws `hex` as inside tmux (measured on Claude Code 2.1.295):
 * greys on the grey ramp, other colors on the 6×6×6 cube with round(v / 51) per channel.
 */
export function quantize256(hex: string): { index: number; hex: string } {
  const [r, g, b] = rgb(hex)
  if (r === g && g === b) {
    if (r < 8) return { index: 16, hex: '#000000' }
    if (r > 248) return { index: 231, hex: '#ffffff' }
    const i = Math.round(((r - 8) / 247) * 24)
    const v = (8 + i * 10).toString(16).padStart(2, '0')
    return { index: 232 + i, hex: `#${v}${v}${v}` }
  }
  const q = [r, g, b].map((c) => Math.round((c / 255) * 5)) as [number, number, number]
  return { index: 16 + 36 * q[0] + 6 * q[1] + q[2], hex: '#' + q.map((c) => CUBE[c]!.toString(16).padStart(2, '0')).join('') }
}

/**
 * `fg` when it reaches `min` (4.5:1; 3:1 for a RECEDING colour) on `bg` as given and, unless the palette is drawn
 * in truecolor, as the 256-colour cells Claude Code draws; else the palette's text color, else black or white.
 * Keeps meta readable on every fill and the selection.
 */
export function readableOn(fg: string, bg: string, p: Palette, min = 4.5): string {
  // A Claude Code theme key (`palette: theme`) follows the person's theme; no contrast math applies to it.
  if (!fg.startsWith('#') || !bg.startsWith('#')) return fg
  const reads = (c: string) => contrastRatio(c, bg) >= min && (p.depth === 'truecolor' || contrastRatio(quantize256(c).hex, quantize256(bg).hex) >= min)
  if (reads(fg)) return fg
  if (reads(p.colors.text)) return p.colors.text
  return p.variant === 'dark' ? '#ffffff' : '#000000'
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Parses the user's config file text (JSON). Flat keys: any ColorKey with a
 * '#rgb' or '#rrggbb' string, `fill.darkness` in [0,1], `theme`: light|dark|auto.
 * One warning per invalid or unknown key; malformed JSON → defaults plus one
 * warning. Never throws.
 */
export function parseConfig(text: string | null): {
  readonly overrides: Partial<Record<ColorKey, string>>
  readonly fillDarkness: number | null
  readonly theme: Variant | null
  readonly warnings: readonly string[]
} {
  const empty = { overrides: {}, fillDarkness: null, theme: null }
  if (text === null) return { ...empty, warnings: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...empty, warnings: ['palette config is not valid JSON; using the default palette'] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...empty, warnings: ['palette config must be a JSON object; using the default palette'] }
  }
  const overrides: Partial<Record<ColorKey, string>> = {}
  const warnings: string[] = []
  let fillDarkness: number | null = null
  let theme: Variant | null = null
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fill.darkness') {
      if (typeof value === 'number' && value >= 0 && value <= 1) fillDarkness = value
      else warnings.push(`fill.darkness: expected a number from 0 to 1, got ${show(value)}; using the default`)
    } else if (key === 'theme') {
      if (value === 'light' || value === 'dark') theme = value
      else if (value !== 'auto') warnings.push(`theme: expected light, dark or auto, got ${show(value)}; ignoring it`)
    } else if (isColorKey(key)) {
      if (typeof value === 'string' && HEX.test(value)) overrides[key] = expand(value)
      else warnings.push(`${key}: expected '#rgb' or '#rrggbb', got ${show(value)}; using the default`)
    } else {
      warnings.push(`${key}: unknown palette key; ignoring it`)
    }
  }
  return { overrides, fillDarkness, theme, warnings }
}

/** Default palette for the variant and colour depth with the parsed overrides applied (`fill.darkness` wins). */
export function buildPalette(variant: Variant, cfg: ReturnType<typeof parseConfig>, depth: ColorDepth = '256'): Palette {
  const base = defaultPalette(variant, depth)
  if (Object.keys(cfg.overrides).length === 0 && cfg.fillDarkness === null) return base
  return {
    ...base,
    colors: { ...base.colors, ...cfg.overrides },
    fillDarkness: cfg.fillDarkness ?? base.fillDarkness,
  }
}

export const THEME_HINT = 'Theme unknown (Claude Code on auto); set `theme: light` if your terminal is light.'

/**
 * The config override wins; else Claude Code's explicit theme
 * (`$.config.list()` key 'theme'); else dark with a hint.
 */
export function resolveTheme(
  override: Variant | null,
  claudeTheme: string | null | undefined,
): { readonly variant: Variant; readonly source: 'override' | 'claude' | 'fallback'; readonly hint: string | null } {
  if (override) return { variant: override, source: 'override', hint: null }
  if (claudeTheme === 'light' || claudeTheme === 'light-daltonized' || claudeTheme === 'light-ansi') {
    return { variant: 'light', source: 'claude', hint: null }
  }
  if (claudeTheme === 'dark' || claudeTheme === 'dark-daltonized' || claudeTheme === 'dark-ansi') {
    return { variant: 'dark', source: 'claude', hint: null }
  }
  return { variant: 'dark', source: 'fallback', hint: THEME_HINT }
}

/**
 * `palette: theme`: foregrounds become Claude Code theme keys, so text follows the person's theme
 * even on `auto`. Fills, the selection, the background and the shimmer band stay hex (they need colour math).
 */
export const THEME_KEYS: Partial<Record<ColorKey, string>> = {
  text: 'text',
  muted: 'inactive',
  accent: 'suggestion',
  'git.A': 'diffAdded',
  'git.untracked': 'diffAdded',
  added: 'diffAdded',
  'git.D': 'error',
  removed: 'error',
  error: 'error',
  'git.M': 'warning',
}

export function themePalette(p: Palette): Palette {
  return { ...p, colors: { ...p.colors, ...THEME_KEYS } as Palette['colors'] }
}

/** WCAG 2.x contrast ratio of two '#rrggbb' colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** CIE76 colour difference of two '#rrggbb' colors in CIELAB (D65): how far apart they look, hue and all. */
export function deltaE(a: string, b: string): number {
  const la = lab(a)
  const lb = lab(b)
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = map3(rgb(hex), linear)
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** Hue in degrees [0,360) of '#rrggbb' (HSL hue). */
export function hue(hex: string): number {
  const [r, g, b] = map3(rgb(hex), (c) => c / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/** Linear blend per channel: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const ca = rgb(a)
  const cb = rgb(b)
  const ch = (i: 0 | 1 | 2) => Math.round(ca[i] + (cb[i] - ca[i]) * t).toString(16).padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

function map3(c: readonly [number, number, number], f: (x: number) => number): [number, number, number] {
  return [f(c[0]), f(c[1]), f(c[2])]
}

function rgb(hex: string): [number, number, number] {
  const h = expand(hex)
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

function luminance(hex: string): number {
  const [r, g, b] = map3(rgb(hex), linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** An sRGB channel 0..255 as linear light 0..1. */
function linear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** '#abc' → '#aabbcc', lowercased. */
function expand(hex: string): string {
  const h = hex.toLowerCase()
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h
}

function isColorKey(key: string): key is ColorKey {
  return (COLOR_KEYS as readonly string[]).includes(key)
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}
