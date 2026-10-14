// Vector forms of the panel's glyphs and bars for surfaces that draw Svg (desktop): a font's symbols come at
// different sizes from different fallback fonts, and a bar of block characters leaves gaps between letters.
// Pure: markup strings only; the hook decides where they go.
import { GLYPHS, METER } from './glyphs.ts'
import { NERD_METER, PLAIN_METER } from './icons.ts'

/** One drawing: the markup and what it says to a reader that cannot see it. */
export type Vector = { readonly source: string; readonly alt: string }

/** The glyphs' box, in CSS pixels: one size for every state, so the gutter reads as one column. */
export const GLYPH_PX = 12

const svg = (body: string, w = GLYPH_PX, h = GLYPH_PX) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
const esc = (c: string) => c.replace(/[^#0-9a-zA-Z(),.% ]/g, '')

/** A pie filled to `fraction` (0 = an empty ring, 1 = a disc), clockwise from the top. */
export function pie(fraction: number, color: string): Vector {
  const c = esc(color)
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const pct = Math.round(f * 100)
  const alt = f >= 1 ? 'read in full' : `read ${pct}%`
  if (f >= 1) return { source: svg(`<circle cx="6" cy="6" r="5" fill="${c}"/>`), alt }
  const ring = `<circle cx="6" cy="6" r="4.6" fill="none" stroke="${c}" stroke-width="1.2"/>`
  if (f <= 0) return { source: svg(ring), alt }
  const a = f * 2 * Math.PI
  const x = (6 + 5 * Math.sin(a)).toFixed(2)
  const y = (6 - 5 * Math.cos(a)).toFixed(2)
  return { source: svg(`${ring}<path d="M6 6V1A5 5 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}z" fill="${c}"/>`), alt }
}

/** The vector form of a gutter or table glyph, or null when it has none (the text stays). */
export function glyphVector(glyph: string, color: string, fraction?: number | null): Vector | null {
  const c = esc(color)
  if (glyph === GLYPHS.full.glyph) return pie(fraction ?? 1, color)
  const step = meterStep(glyph)
  if (step !== null) return pie(fraction ?? step, color)
  switch (glyph) {
    case GLYPHS.match.glyph:
      return { source: svg(`<path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="${c}" stroke-width="1.2"/>`), alt: 'matched by a search' }
    case GLYPHS.committed.glyph:
      return { source: svg(`<path d="M6 1 11 6 6 11 1 6z" fill="${c}"/>`), alt: 'committed' }
    case GLYPHS.busy.glyph:
      return { source: svg(`<circle cx="6" cy="6" r="4.6" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="2 1.8"/>`), alt: 'in progress' }
    case GLYPHS.seen.glyph:
      return { source: svg(`<circle cx="6" cy="6" r="1.6" fill="${c}"/>`), alt: 'seen only' }
    case GLYPHS.edited.glyph:
      return { source: svg(`<path d="M2 10l.6-2.6L8.4 1.6l2 2-5.8 5.8z" fill="none" stroke="${c}" stroke-width="1.2" stroke-linejoin="round"/>`), alt: 'edited' }
    case GLYPHS.auto.glyph:
      return { source: svg(`<path d="M7 .8 2.4 7h3.2L5 11.2 9.6 5H6.4z" fill="${c}"/>`), alt: 'loaded by Claude Code' }
  }
  return null
}

/** How full a meter step glyph (plain or Nerd) draws, or null when the glyph is no meter step. */
function meterStep(glyph: string): number | null {
  if (glyph === METER.most.glyph) return 0.75
  if (glyph === METER.half.glyph) return 0.5
  if (glyph === METER.part.glyph) return 0.25
  for (const steps of [PLAIN_METER, NERD_METER] as readonly (readonly string[])[]) {
    const i = steps.indexOf(glyph)
    if (i >= 0) return i / (steps.length - 1)
  }
  return null
}

/**
 * A horizontal bar: `parts` of a track, each a share (0–1) in its colour, laid end to end from the left. Its markup
 * is 100% wide and stretches to its box, so it spans whatever width the pane has.
 */
export function bar(parts: readonly { readonly share: number; readonly color: string }[], track: string, w = 1000, h = 6): Vector {
  let x = 0
  const fills = parts
    .map((p) => {
      const pw = Math.max(0, Math.min(w - x, p.share * w))
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${pw.toFixed(1)}" height="${h}" fill="${esc(p.color)}"/>`
      x += pw
      return r
    })
    .join('')
  const alt = parts.map((p) => `${Math.round(p.share * 100)}%`).join(', ')
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect width="${w}" height="${h}" fill="${esc(track)}"/>${fills}</svg>`, alt }
}

/** Where in a file lines were read and edited: spans of 1-based line ranges over `total` lines, in their colours; stretches to its box. */
export function strip(total: number, spans: readonly { readonly from: number; readonly to: number; readonly color: string }[], track: string, w = 1000, h = 12): Vector {
  const n = Math.max(1, total)
  const rects = spans
    .map((s) => {
      const x = ((s.from - 1) / n) * w
      const sw = Math.max(1.5, ((s.to - s.from + 1) / n) * w)
      return `<rect x="${x.toFixed(1)}" y="0" width="${sw.toFixed(1)}" height="${h}" fill="${esc(s.color)}"/>`
    })
    .join('')
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect width="${w}" height="${h}" fill="${esc(track)}"/>${rects}</svg>`, alt: `where the lines read sit in the file's ${total} lines` }
}
