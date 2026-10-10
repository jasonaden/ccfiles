import { describe, expect, test } from 'claude-code/testing'
import {
  buildPalette,
  colorDepth,
  contrastRatio,
  defaultPalette,
  fillBackground,
  hue,
  mix,
  parseConfig,
  quantize256,
  readableOn,
  resolveTheme,
  type ColorDepth,
  type ColorEnv,
  type ColorKey,
  type FillTone,
  type Variant,
} from '../src/palette.ts'

const AVOIDED_HUES = { purple: '#a855f7', orange: '#f97316', green: '#22c55e' }
const VARIANTS: Variant[] = ['dark', 'light']
const HINT = 'Theme unknown (Claude Code on auto); set `theme: light` if your terminal is light.'

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

describe('color math', () => {
  test('contrast ratio spans 1..21', () => {
    expect(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01).toBe(true)
    expect(contrastRatio('#ffffff', '#000000')).toBe(contrastRatio('#000000', '#ffffff'))
    expect(contrastRatio('#777777', '#777777')).toBe(1)
  })

  test('HSL hue of primaries', () => {
    expect(hue('#ff0000')).toBe(0)
    expect(hue('#00ff00')).toBe(120)
    expect(hue('#0000ff')).toBe(240)
  })

  test('mix goes from a at 0 to b at 1', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})

describe('default palette', () => {
  for (const variant of VARIANTS) {
    test(`${variant}: read/edit/commit hues are ≥30° from the avoided purple, orange and green`, () => {
      const p = defaultPalette(variant)
      for (const key of ['read', 'edit', 'commit'] as const) {
        for (const [name, hex] of Object.entries(AVOIDED_HUES)) {
          const d = hueDistance(hue(p.colors[key]), hue(hex))
          if (d < 30) throw new Error(`${variant} ${key} ${p.colors[key]} is ${d.toFixed(1)}° from ${name}`)
        }
      }
    })
  }

  test('with no config the default palette loads unchanged', () => {
    const cfg = parseConfig(null)
    expect(cfg.warnings).toEqual([])
    expect(buildPalette('dark', cfg)).toEqual(defaultPalette('dark'))
    expect(buildPalette('light', cfg)).toEqual(defaultPalette('light'))
  })

  test('every color is #rrggbb', () => {
    for (const variant of VARIANTS) {
      const p = defaultPalette(variant)
      for (const c of [p.background, ...Object.values(p.colors)]) expect(/^#[0-9a-f]{6}$/.test(c)).toBe(true)
    }
  })

})

describe('state-tinted row fill', () => {
  const TONES: FillTone[] = ['read', 'edit', 'commit']
  const HUES: Record<FillTone, [number, number]> = { read: [200, 245], edit: [330, 360], commit: [50, 65] }

  for (const variant of VARIANTS) {
    test(`${variant}: ice blue read, rose edit, gold commit; distinct, dark/light muted, ≥30° from the avoided hues`, () => {
      const p = defaultPalette(variant)
      const tints = TONES.map((t) => fillBackground(p, t))
      expect(new Set(tints).size).toBe(3)
      TONES.forEach((t, i) => {
        const h = hue(tints[i]!)
        if (h < HUES[t][0] || h > HUES[t][1]) throw new Error(`${variant} ${t} tint ${tints[i]} hue ${h.toFixed(0)}`)
        for (const [name, hex] of Object.entries(AVOIDED_HUES)) {
          if (hueDistance(h, hue(hex)) < 30) throw new Error(`${variant} ${t} tint ${tints[i]} is within 30° of ${name}`)
        }
        // A muted tint: close to the background in contrast, never a bright bar.
        expect(contrastRatio(tints[i]!, p.background)).toBeLessThan(variant === 'dark' ? 1.6 : 1.35)
      })
    })
  }

  test('dark tints stay coloured when Claude Code quantizes to 256 colours (inside tmux), never the flat grey 59', () => {
    const p = defaultPalette('dark')
    expect(TONES.map((t) => quantize256(fillBackground(p, t)).index)).toEqual([17, 52, 58])
    // A flat grey tint lands on cube 59.
    expect(quantize256('#272e38').index).toBe(59)
    expect(quantize256('#3a3a3a').index).toBe(237)
  })

  for (const variant of VARIANTS) {
    test(`${variant}: every name/meta color reaches 4.5:1 on every fill and the selection, in truecolor and in 256 colours`, () => {
      const p = defaultPalette(variant)
      const FG: ColorKey[] = ['text', 'muted', 'read', 'search', 'edit', 'commit', 'instruction', 'pending', 'error', 'git.A', 'git.M', 'git.D', 'git.R', 'git.untracked', 'git.ignored', 'added', 'removed', 'accent']
      for (const bg of [p.background, p.colors.selection, ...TONES.map((t) => fillBackground(p, t))]) {
        for (const key of FG) {
          const fg = readableOn(p.colors[key], bg, p)
          const exact = contrastRatio(fg, bg)
          const q = contrastRatio(quantize256(fg).hex, quantize256(bg).hex)
          if (exact < 4.5 || q < 4.5) throw new Error(`${variant} ${key} → ${fg} on ${bg}: ${exact.toFixed(2)} / 256: ${q.toFixed(2)}`)
        }
      }
    })
  }

  test('readableOn keeps a color that already reads and swaps one that does not', () => {
    const p = defaultPalette('dark')
    expect(readableOn(p.colors.muted, p.background, p)).toBe(p.colors.muted)
    expect(readableOn(p.colors.muted, '#5f5f00', p)).not.toBe(p.colors.muted)
  })

  test('colors-file keys still work: fill (read tint source), fill.edit, fill.commit and fill.darkness', () => {
    const base = defaultPalette('dark')
    const p = buildPalette('dark', parseConfig('{"fill":"#00ff00","fill.commit":"#ff0000","fill.darkness":0.5}'))
    expect(fillBackground(p, 'read')).toBe(mix('#00ff00', '#000000', 0.5))
    expect(fillBackground(p, 'commit')).toBe(mix('#ff0000', '#000000', 0.5))
    expect(fillBackground(p, 'edit')).toBe(mix(base.colors['fill.edit'], '#000000', 0.5))
  })
})

describe('colour depth from the environment', () => {
  // How Claude Code 2.1.295 picks its colour depth (read off its colour code and captures on the box).
  const CASES: [string, ColorEnv, ColorDepth][] = [
    ['nothing set', {}, '256'],
    ['plain xterm', { TERM: 'xterm-256color' }, '256'],
    ['COLORTERM=truecolor', { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 'truecolor'],
    ['COLORTERM=24bit', { COLORTERM: '24bit' }, 'truecolor'],
    ['COLORTERM other', { COLORTERM: 'yes' }, '256'],
    ['kitty', { TERM: 'xterm-kitty' }, 'truecolor'],
    ['ghostty', { TERM: 'xterm-ghostty' }, 'truecolor'],
    ['wezterm', { TERM: 'wezterm' }, 'truecolor'],
    ['alacritty', { TERM: 'alacritty' }, 'truecolor'],
    ['foot', { TERM: 'foot-extra' }, 'truecolor'],
    ['contour', { TERM: 'contour' }, 'truecolor'],
    ['rio', { TERM: 'rio' }, 'truecolor'],
    ['tmux with COLORTERM=truecolor: clamped', { TERM: 'tmux-256color', COLORTERM: 'truecolor', TMUX: '/tmp/tmux-0/default,1,0' }, '256'],
    ['tmux inside kitty: clamped', { TERM: 'xterm-kitty', TMUX: '/tmp/t,1,0' }, '256'],
    ['tmux with CLAUDE_CODE_TMUX_TRUECOLOR', { TERM: 'tmux-256color', COLORTERM: 'truecolor', TMUX: '/tmp/t,1,0', CLAUDE_CODE_TMUX_TRUECOLOR: '1' }, 'truecolor'],
    ['CLAUDE_CODE_TMUX_TRUECOLOR alone does not add colour', { TMUX: '/tmp/t,1,0', CLAUDE_CODE_TMUX_TRUECOLOR: '1' }, '256'],
    ['NO_COLOR', { NO_COLOR: '1', COLORTERM: 'truecolor' }, 'none'],
    ['NO_COLOR empty is unset', { NO_COLOR: '', COLORTERM: 'truecolor' }, 'truecolor'],
    ['TERM=dumb', { TERM: 'dumb', COLORTERM: 'truecolor' }, 'none'],
  ]
  for (const [name, env, depth] of CASES) {
    test(`${name} → ${depth}`, () => {
      expect(colorDepth(env)).toBe(depth)
    })
  }
})

describe('fill strength by colour depth', () => {
  const TONES: FillTone[] = ['read', 'edit', 'commit']
  const SOURCE = { read: 'fill', edit: 'fill.edit', commit: 'fill.commit' } as const

  for (const variant of VARIANTS) {
    test(`${variant} truecolor: a subtle tint, 30% of the state colour over the panel background`, () => {
      const p = defaultPalette(variant, 'truecolor')
      for (const t of TONES) expect(fillBackground(p, t)).toBe(mix(p.colors[SOURCE[t]], p.background, 0.7))
      // A tint, not a bar: close to the background.
      for (const t of TONES) expect(contrastRatio(fillBackground(p, t), p.background)).toBeLessThan(1.7)
    })
  }

  test('dark truecolor tints are lighter than the 256-colour set (which stays dark so it keeps its hue in 256 cells)', () => {
    const tc = defaultPalette('dark', 'truecolor')
    const sat = defaultPalette('dark', '256')
    for (const t of TONES) expect(contrastRatio(fillBackground(tc, t), '#000000')).toBeGreaterThan(contrastRatio(fillBackground(sat, t), '#000000'))
  })

  test('256 colours: the saturated set, navy 17, maroon 52, olive 58 on dark', () => {
    const p = defaultPalette('dark', '256')
    expect(TONES.map((t) => quantize256(fillBackground(p, t)).index)).toEqual([17, 52, 58])
    expect(defaultPalette('dark')).toEqual(p)
  })

  test('no colour (NO_COLOR, TERM=dumb) keeps the 256-colour palette; glyphs carry the state', () => {
    expect(defaultPalette('dark', 'none').colors).toEqual(defaultPalette('dark', '256').colors)
  })

  test('fill.darkness overrides either default', () => {
    for (const depth of ['truecolor', '256'] as const) {
      const p = buildPalette('dark', parseConfig('{"fill.darkness":0.4}'), depth)
      expect(p.fillDarkness).toBe(0.4)
      expect(fillBackground(p, 'read')).not.toBe(fillBackground(defaultPalette('dark', depth), 'read'))
    }
    expect(fillBackground(buildPalette('dark', parseConfig('{"fill.darkness":0.4}'), '256'), 'read')).toBe(mix(defaultPalette('dark').colors.fill, '#000000', 0.4))
    expect(fillBackground(buildPalette('dark', parseConfig('{"fill.darkness":0.4}'), 'truecolor'), 'read')).toBe(mix(defaultPalette('dark').colors.fill, '#262626', 0.4))
  })

  for (const variant of VARIANTS) {
    test(`${variant} truecolor: hues stay ice blue / rose / gold; every name and meta color reads 4.5:1 on every tint`, () => {
      const p = defaultPalette(variant, 'truecolor')
      const HUES: Record<FillTone, [number, number]> = { read: [200, 245], edit: [330, 360], commit: [45, 65] }
      for (const t of TONES) {
        const h = hue(fillBackground(p, t))
        if (h < HUES[t][0] || h > HUES[t][1]) throw new Error(`${variant} ${t} ${fillBackground(p, t)} hue ${h.toFixed(0)}`)
      }
      const FG: ColorKey[] = ['text', 'muted', 'read', 'search', 'edit', 'commit', 'instruction', 'pending', 'error', 'git.A', 'git.M', 'git.D', 'git.R', 'git.untracked', 'git.ignored', 'added', 'removed', 'accent']
      for (const bg of [p.background, p.colors.selection, ...TONES.map((t) => fillBackground(p, t))]) {
        for (const key of FG) {
          const fg = readableOn(p.colors[key], bg, p)
          if (contrastRatio(fg, bg) < 4.5) throw new Error(`${variant} ${key} → ${fg} on ${bg}: ${contrastRatio(fg, bg).toFixed(2)}`)
        }
      }
      // In truecolor a color that reads as drawn is kept, even when its 256-colour cell would not.
      const tint = fillBackground(p, 'commit')
      expect(contrastRatio(quantize256(p.colors.read).hex, quantize256(tint).hex)).toBeLessThan(4.5)
      expect(readableOn(p.colors.read, tint, p)).toBe(p.colors.read)
    })
  }
})

describe('config overrides', () => {
  test('custom read color and fill.darkness change the row color and fill', () => {
    const base = defaultPalette('dark')
    const p = buildPalette('dark', parseConfig('{"read":"#123456","fill.darkness":0.5}'))
    expect(p.colors.read).toBe('#123456')
    expect(p.fillDarkness).toBe(0.5)
    expect(fillBackground(p)).not.toBe(fillBackground(base))
    expect(p.colors.edit).toBe(base.colors.edit)
  })

  test('short #rgb colors expand', () => {
    expect(buildPalette('light', parseConfig('{"accent":"#AbC"}')).colors.accent).toBe('#aabbcc')
  })

  test('an invalid value keeps that key default with one warning naming it', () => {
    const cfg = parseConfig('{"edit":"notacolor","read":"#123456"}')
    expect(cfg.warnings.length).toBe(1)
    expect(cfg.warnings[0]).toContain('edit')
    const p = buildPalette('dark', cfg)
    expect(p.colors.edit).toBe(defaultPalette('dark').colors.edit)
    expect(p.colors.read).toBe('#123456')
  })

  test('malformed JSON falls back to the full default with one warning', () => {
    for (const text of ['{not json', '[1,2]', '"dark"', 'null']) {
      const cfg = parseConfig(text)
      expect(cfg.warnings.length).toBe(1)
      expect(cfg.theme).toBe(null)
      expect(buildPalette('dark', cfg)).toEqual(defaultPalette('dark'))
    }
  })

  test('fill.darkness out of range keeps the default with one warning', () => {
    for (const v of ['1.5', '-0.1', '"0.5"']) {
      const cfg = parseConfig(`{"fill.darkness":${v}}`)
      expect(cfg.warnings.length).toBe(1)
      expect(cfg.warnings[0]).toContain('fill.darkness')
      expect(buildPalette('dark', cfg).fillDarkness).toBe(defaultPalette('dark').fillDarkness)
    }
  })

  test('unknown keys warn once each; theme parses, auto means no override', () => {
    const cfg = parseConfig('{"purple":"#a855f7","glow":1,"theme":"light"}')
    expect(cfg.warnings.length).toBe(2)
    expect(cfg.theme).toBe('light')
    expect(parseConfig('{"theme":"auto"}')).toEqual({ overrides: {}, fillDarkness: null, theme: null, warnings: [] })
    expect(parseConfig('{"theme":"sepia"}').warnings.length).toBe(1)
  })
})

describe('theme resolution', () => {
  test('config theme override wins over Claude Code', () => {
    expect(resolveTheme('light', 'dark')).toEqual({ variant: 'light', source: 'override', hint: null })
  })

  test('explicit Claude Code light themes resolve to light', () => {
    expect(resolveTheme(null, 'light-daltonized')).toEqual({ variant: 'light', source: 'claude', hint: null })
    expect(resolveTheme(null, 'light').variant).toBe('light')
    expect(resolveTheme(null, 'light-ansi').variant).toBe('light')
  })

  test('explicit Claude Code dark themes resolve to dark without a hint', () => {
    expect(resolveTheme(null, 'dark-ansi')).toEqual({ variant: 'dark', source: 'claude', hint: null })
  })

  test('auto, unknown or missing falls back to dark with the hint', () => {
    for (const t of ['auto', 'solarized', null, undefined]) {
      expect(resolveTheme(null, t)).toEqual({ variant: 'dark', source: 'fallback', hint: HINT })
    }
  })
})

describe('contrast', () => {
  const FOREGROUNDS: ColorKey[] = [
    'text', 'muted', 'read', 'search', 'edit', 'commit', 'instruction', 'pending', 'error',
    'git.A', 'git.M', 'git.D', 'git.R', 'git.untracked', 'git.ignored', 'added', 'removed', 'accent',
  ]
  for (const variant of VARIANTS) {
    test(`${variant}: names, meta and state colors reach 4.5:1 on plain and selected rows as configured (filled rows: see the state-tinted row fill tests)`, () => {
      const p = defaultPalette(variant)
      for (const key of FOREGROUNDS) {
        for (const bg of [p.background, p.colors.selection]) {
          const r = contrastRatio(p.colors[key], bg)
          if (r < 4.5) throw new Error(`${variant} ${key} ${p.colors[key]} on ${bg}: ${r.toFixed(2)}`)
        }
      }
    })
  }
})
