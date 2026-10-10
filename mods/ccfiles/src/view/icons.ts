// File-type icons and the coverage meter, in two glyph sets: `nerd` (a Nerd Font is
// installed) and `plain` (Unicode that ordinary monospace fonts draw). Nerd codepoints come from the Nerd Fonts
// cheat sheet / glyphnames.json (v3 names: nf-seti-*, nf-dev-*, nf-custom-*, nf-oct-*, nf-md-* in F0001+; none
// from the retired nf-mdi F500–FD46 range). Language colours are from nvim-web-devicons (MIT, see
// ACKNOWLEDGEMENTS.md). Every nerd glyph is one Private Use Area code point, counted as 1 cell and always followed
// by a space when drawn.

export type GlyphSet = 'nerd' | 'plain'

export type IconKind = 'folder' | 'folderOpen' | 'repo' | 'file' | 'system' | 'branch' | 'caretClosed' | 'caretOpen'

/** A glyph and, for file types that have one, its language colour ('#rrggbb'). */
export type Icon = { readonly g: string; readonly c?: string }

const NERD: Record<IconKind, string> = {
  folder: '\u{E5FF}', // nf-custom-folder
  folderOpen: '\u{E5FE}', // nf-custom-folder_open
  repo: '\u{E702}', // nf-dev-git
  file: '\u{F0214}', // nf-md-file
  system: '\u{F06A9}', // nf-md-robot (a Claude Code load)
  branch: '\u{F418}', // nf-oct-git_branch (in every Nerd Font v2/v3 build)
  caretClosed: '\u{F460}', // nf-oct-chevron_right
  caretOpen: '\u{F47C}', // nf-oct-chevron_down
}

const PLAIN: Record<IconKind, string> = {
  folder: '■',
  folderOpen: '■',
  repo: '■',
  file: '·',
  system: '⚡', // 2 cells in cellWidth, unlike every other icon
  branch: '⎇',
  caretClosed: '▸',
  caretOpen: '▾',
}

export function icon(kind: IconKind, set: GlyphSet): string {
  return set === 'nerd' ? NERD[kind] : PLAIN[kind]
}

// Nerd glyphs shared by several entries below.
const TS = '\u{E628}' // nf-seti-typescript
const REACT = '\u{E625}' // nf-seti-react
const JS = '\u{E60C}' // nf-seti-javascript
const JSON_ = '\u{E60B}' // nf-seti-json
const MD = '\u{E73E}' // nf-dev-markdown
const YML = '\u{E6A8}' // nf-seti-yml
const TERM = '\u{E795}' // nf-dev-terminal
const C = '\u{E649}' // nf-seti-c
const IMAGE = '\u{E60D}' // nf-seti-image
const LOCK = '\u{E672}' // nf-seti-lock
const NPM = '\u{E616}' // nf-seti-npm

/** By lower-cased extension (the text after the last dot). */
const BY_EXT: Record<string, Icon> = {
  ts: { g: TS, c: '#519aba' },
  tsx: { g: REACT, c: '#1354bf' },
  js: { g: JS, c: '#cbcb41' },
  jsx: { g: REACT, c: '#20c2e3' },
  mjs: { g: JS, c: '#f1e05a' },
  cjs: { g: JS, c: '#cbcb41' },
  json: { g: JSON_, c: '#cbcb41' },
  md: { g: MD, c: '#dddddd' },
  mdx: { g: MD, c: '#519aba' },
  yaml: { g: YML, c: '#d70000' },
  yml: { g: YML, c: '#d70000' },
  toml: { g: '\u{E6B2}', c: '#9c4221' }, // nf-custom-toml
  sh: { g: TERM, c: '#4d5a5e' },
  bash: { g: TERM, c: '#89e051' },
  zsh: { g: TERM, c: '#89e051' },
  py: { g: '\u{E606}', c: '#ffbc03' }, // nf-seti-python
  go: { g: '\u{E627}', c: '#00add8' }, // nf-seti-go
  rs: { g: '\u{E7A8}', c: '#dea584' }, // nf-dev-rust
  rb: { g: '\u{E605}', c: '#701516' }, // nf-seti-ruby
  java: { g: '\u{E66D}', c: '#cc3e44' }, // nf-seti-java
  kt: { g: '\u{E634}', c: '#7f52ff' }, // nf-seti-kotlin
  swift: { g: '\u{E699}', c: '#e37933' }, // nf-seti-swift
  c: { g: C, c: '#599eff' },
  h: { g: C, c: '#a074c4' },
  cpp: { g: '\u{E646}', c: '#519aba' }, // nf-seti-cpp
  css: { g: '\u{E614}', c: '#663399' }, // nf-seti-css
  scss: { g: '\u{E603}', c: '#f55385' }, // nf-seti-sass
  html: { g: '\u{E60E}', c: '#e44d26' }, // nf-seti-html
  svg: { g: '\u{E698}', c: '#ffb13b' }, // nf-seti-svg
  png: { g: IMAGE, c: '#a074c4' },
  jpg: { g: IMAGE, c: '#a074c4' },
  jpeg: { g: IMAGE, c: '#a074c4' },
  gif: { g: IMAGE, c: '#a074c4' },
  sql: { g: '\u{E64D}', c: '#dad8d8' }, // nf-seti-db
  lock: { g: LOCK, c: '#bbbbbb' },
}

/** By whole lower-cased file name; wins over the extension. */
const BY_NAME: Record<string, Icon> = {
  'package.json': { g: NPM, c: '#e8274b' },
  'package-lock.json': { g: NPM, c: '#7a0d21' },
  'pnpm-lock.yaml': { g: LOCK, c: '#bbbbbb' },
  'tsconfig.json': { g: '\u{E69D}', c: '#519aba' }, // nf-seti-tsconfig
  dockerfile: { g: '\u{E650}', c: '#458ee6' }, // nf-seti-docker
  makefile: { g: '\u{E673}', c: '#6d8086' }, // nf-seti-makefile
  '.gitignore': { g: '\u{E65D}', c: '#f54d27' }, // nf-seti-git
  license: { g: '\u{E60A}', c: '#d0bf41' }, // nf-seti-license
  '.env': { g: '\u{E615}', c: '#faf743' }, // nf-seti-config
}

const GENERIC: Icon = { g: NERD.file }

/** The name's own entry, else a variant (`.env.local`, `LICENSE.md`, `Dockerfile.dev`), else the extension's. */
function lookup(name: string): Icon {
  const n = name.toLowerCase()
  const exact = BY_NAME[n]
  if (exact) return exact
  if (n.startsWith('.env.')) return BY_NAME['.env']!
  const stem = n.split('.')[0]!
  if (stem === 'license' || stem === 'licence') return BY_NAME.license!
  if (stem === 'dockerfile') return BY_NAME.dockerfile!
  const dot = n.lastIndexOf('.')
  return (dot > 0 && BY_EXT[n.slice(dot + 1)]) || GENERIC
}

/** The icon for a file's base name. Plain is always the generic `·`, with no colour. */
export function fileIcon(name: string, set: GlyphSet): Icon {
  return set === 'nerd' ? lookup(name) : { g: PLAIN.file }
}

const PLAIN_METER = ['○', '◔', '◑', '◕', '●'] as const
const NERD_METER = [
  '\u{F0766}', // nf-md-circle_outline (nothing read)
  '\u{F0A9E}', // nf-md-circle_slice_1
  '\u{F0A9F}', // nf-md-circle_slice_2
  '\u{F0AA0}', // nf-md-circle_slice_3
  '\u{F0AA1}', // nf-md-circle_slice_4
  '\u{F0AA2}', // nf-md-circle_slice_5
  '\u{F0AA3}', // nf-md-circle_slice_6
  '\u{F0AA4}', // nf-md-circle_slice_7
  '\u{F0AA5}', // nf-md-circle_slice_8
] as const

/**
 * The coverage meter: the empty step only at 0 (or below, or NaN), the full step only at 1 (or above), and
 * anything in between rounds to the nearest partial step, so a sliver read never looks unread and a nearly
 * complete read never looks complete.
 */
export function meterGlyph(fraction: number, set: GlyphSet): string {
  const steps: readonly string[] = set === 'nerd' ? NERD_METER : PLAIN_METER
  const last = steps.length - 1
  if (!(fraction > 0)) return steps[0]!
  if (fraction >= 1) return steps[last]!
  return steps[Math.min(last - 1, Math.max(1, Math.round(fraction * last)))]!
}

/** Unicode Private Use Areas: the BMP block and planes 15–16, where Nerd Font glyphs live. */
export function isPrivateUse(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd)
}
