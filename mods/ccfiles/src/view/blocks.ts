// The detail, help and usage views as blocks: a title, status chips, stat cards, a strip of the lines read, tables
// with named columns, and term tables (a key or glyph, then what it means). One model, two drawings: the terminal
// lays the blocks out as lines on its cell grid (here); desktop draws them as boxes, text and vectors (the hook).
import type { ColorKey } from '../palette.ts'
import type { Chip } from './rows.ts'
import { cellWidth } from './text.ts'

export type DetailLine = readonly Chip[]

/** A file's place in its view: name, path, and the `?` of an unverified detection. */
export type TitleBlock = { readonly kind: 'title'; readonly name: string; readonly path: string; readonly mark: string }
/** Short states as chips: `✎ edited twice`, `+48 −12 uncommitted`. */
export type ChipsBlock = { readonly kind: 'chips'; readonly chips: readonly Chip[] }
/** Two to four figures side by side: a label, the figure, a line saying what it counts. */
export type StatsBlock = { readonly kind: 'stats'; readonly items: readonly { readonly label: string; readonly value: string; readonly sub: string }[] }
/** Where in a file lines were read and edited, over its length. */
export type StripBlock = {
  readonly kind: 'strip'
  readonly total: number
  readonly spans: readonly { readonly from: number; readonly to: number; readonly color: ColorKey }[]
  readonly legend: readonly Chip[]
  readonly ranges: readonly Chip[]
}
/** Rows under named columns; a cell is chips, a right-aligned column holds figures. */
export type TableBlock = {
  readonly kind: 'table'
  readonly title?: string
  readonly columns: readonly { readonly label: string; readonly right?: boolean }[]
  readonly rows: readonly (readonly (readonly Chip[])[])[]
}
/** A glyph a surface may draw as a vector: its text, colour and, for a meter, how full. */
export type Glyph = { readonly text: string; readonly color: ColorKey; readonly fraction?: number }
/** Two columns: a term (a key, a glyph, a word) and what it means. */
export type TermsBlock = {
  readonly kind: 'terms'
  readonly title?: string
  readonly rows: readonly { readonly term: Chip | Glyph; readonly glyph?: boolean; readonly meaning: readonly Chip[] }[]
}
export type HeadingBlock = { readonly kind: 'heading'; readonly text: string }
export type NoteBlock = { readonly kind: 'note'; readonly chips: readonly Chip[] }

export type Block = TitleBlock | ChipsBlock | StatsBlock | StripBlock | TableBlock | TermsBlock | HeadingBlock | NoteBlock

const muted = (text: string): Chip => ({ text, color: 'muted' })
const pad = (t: string, w: number) => t + ' '.repeat(Math.max(0, w - cellWidth(t)))
const chipsWidth = (cs: readonly Chip[]) => cs.reduce((n, c) => n + cellWidth(c.text), 0)

/** Cells the terminal's strip spans at most. */
export const STRIP_CELLS = 48
/** The blocks as terminal lines, `width` cells wide at most: tables padded to their columns, a term table's meanings in one column. */
export function blockLines(blocks: readonly Block[], width = 72): DetailLine[] {
  const out: DetailLine[] = []
  const gap = () => {
    if (out.length > 0 && out[out.length - 1]!.length > 0) out.push([])
  }
  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        out.push([{ text: b.name, color: 'text' }, ...(b.mark ? [{ text: ` ${b.mark}`, color: 'accent' as const }] : [])])
        if (b.path) out.push([muted(b.path)])
        break
      case 'chips':
        if (b.chips.length) out.push(b.chips.flatMap((c, i) => (i > 0 ? [muted(' · '), c] : [c])))
        break
      case 'stats': {
        // One figure a line: its label, the figure, what it counts.
        gap()
        const w = Math.max(...b.items.map((s) => cellWidth(s.label))) + 2
        for (const s of b.items) out.push([{ text: pad(s.label.toUpperCase(), w), color: 'muted', hang: true }, { text: s.value, color: 'text' }, muted(`  ${s.sub}`)])
        break
      }
      case 'strip': {
        gap()
        const span = Math.max(8, Math.min(STRIP_CELLS, width - 2))
        const cells: string[] = Array.from({ length: span }, () => '░')
        const colors: ColorKey[] = Array.from({ length: span }, () => 'muted')
        const n = Math.max(1, b.total)
        for (const s of b.spans) {
          const a = Math.floor(((s.from - 1) / n) * span)
          const z = Math.max(a + 1, Math.round((s.to / n) * span))
          for (let i = a; i < Math.min(span, z); i++) {
            cells[i] = '█'
            colors[i] = s.color
          }
        }
        const runs: Chip[] = []
        for (let i = 0; i < span; i++) {
          const last = runs[runs.length - 1]
          if (last && last.color === colors[i]) runs[runs.length - 1] = { ...last, text: last.text + cells[i] }
          else runs.push({ text: cells[i]!, color: colors[i]! })
        }
        out.push([muted('▕'), ...runs, muted('▏')])
        const end = b.total.toLocaleString('en-US')
        out.push([muted(pad('1', span + 2 - cellWidth(end)) + end)])
        if (b.ranges.length) out.push(b.ranges)
        if (b.legend.length) out.push(b.legend)
        break
      }
      case 'table': {
        gap()
        if (b.title) out.push([muted(b.title.toUpperCase())])
        const widths = b.columns.map((c, i) => Math.max(cellWidth(c.label), ...b.rows.map((r) => chipsWidth(r[i] ?? []))))
        const cell = (cs: readonly Chip[], i: number): Chip[] => {
          const room = widths[i]! - chipsWidth(cs)
          const sep = i > 0 ? [muted('  ')] : []
          return b.columns[i]!.right ? [...sep, muted(' '.repeat(room)), ...cs] : [...sep, ...cs, muted(' '.repeat(room))]
        }
        out.push(b.columns.flatMap((c, i) => cell([muted(c.label)], i)))
        for (const r of b.rows) out.push(b.columns.flatMap((_, i) => cell(r[i] ?? [], i)))
        break
      }
      case 'terms': {
        gap()
        if (b.title) out.push([muted(b.title.toUpperCase())])
        const w = Math.max(...b.rows.map((r) => cellWidth(r.term.text))) + 2
        for (const r of b.rows) out.push([{ text: pad(r.term.text, w), color: r.term.color, hang: true }, ...r.meaning])
        break
      }
      case 'heading':
        gap()
        out.push([muted(b.text.toUpperCase())])
        break
      case 'note':
        gap()
        out.push(b.chips)
        break
    }
  }
  return out
}
