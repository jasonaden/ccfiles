import { describe, expect, test } from 'claude-code/testing'
import { contrastRatio, defaultPalette, deltaE, fillBackground, quantize256, type FillTone } from '../src/palette.ts'
import { shimmerBands } from '../src/view/draw.ts'

const LITS = ['read', 'search', 'edit', 'commit', 'instruction'] as const
const TONES: FillTone[] = ['read', 'edit', 'commit']

describe('shimmer band', () => {
  for (const variant of ['dark', 'light'] as const) {
    for (const depth of ['256', 'truecolor'] as const) {
      const p = defaultPalette(variant, depth)

      test(`${variant} ${depth}: four steps per state rising to the state colour`, () => {
        const bands = shimmerBands(p)
        for (const lit of LITS) {
          expect(bands[lit]).toHaveLength(4)
          expect(bands[lit][3]!.bg).toBe(p.colors[lit])
          expect(new Set(bands[lit].map((b) => b.bg)).size).toBe(4)
        }
      })

      if (depth === '256') {
        test(`${variant} ${depth}: every band step stays visible in 256 colours, off the background and every fill`, () => {
          const under = [p.background, ...TONES.map((t) => fillBackground(p, t))].map((c) => quantize256(c).index)
          for (const lit of LITS) {
            for (const b of shimmerBands(p)[lit]) {
              const cell = quantize256(b.bg).index
              if (under.includes(cell)) throw new Error(`${variant} ${depth} ${lit} band ${b.bg} → cell ${cell}, same as ${under.join('/')}`)
            }
          }
        })
      } else {
        // The truecolor set is drawn only in truecolor (256 colours keep their own set), so the band is checked
        // as drawn: every step clearly differs (ΔE ≥ 5) from the background and every fill.
        test(`${variant} ${depth}: every band step stays visible as drawn, off the background and every fill`, () => {
          const under = [p.background, ...TONES.map((t) => fillBackground(p, t))]
          for (const lit of LITS) {
            for (const b of shimmerBands(p)[lit]) {
              for (const u of under) {
                if (deltaE(b.bg, u) < 5) throw new Error(`${variant} ${depth} ${lit} band ${b.bg} is ΔE ${deltaE(b.bg, u).toFixed(1)} from ${u}`)
              }
            }
          }
        })
      }

      test(`${variant} ${depth}: text on the band takes whichever of the panel's text or background reads better`, () => {
        for (const lit of LITS) {
          for (const b of shimmerBands(p)[lit]) {
            const best = Math.max(contrastRatio(p.colors.text, b.bg), contrastRatio(p.background, b.bg))
            expect(contrastRatio(b.fg, b.bg)).toBe(best)
          }
        }
      })
    }
  }
})
