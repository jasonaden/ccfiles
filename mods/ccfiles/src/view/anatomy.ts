// Row anatomy: one job per column. Lays out one list row from parts that already carry their
// colours, exactly `width` cells wide:
//
//   gutter(2) · space · indent · caret slot(2) · icon(2) · name · marks │ git column │ value column
//
// The git and value columns have fixed widths across the visible window (the caller measures them with
// `columnWidths`), so their right edges line up down the panel. Below ~48 columns parts drop in this order:
// the icon, then git meta shortened to its first figure, then git meta entirely. The name keeps ≥ 12 cells.
import { cellWidth, takeCells, type Segment } from './text.ts'

/** One colored run (hex or theme key); `cellWidth` decides its width, a Private Use Area glyph counting 1. */
export type Part = { readonly text: string; readonly fg?: string; readonly bold?: boolean }

export type RowParts = {
  /** The column header and totals rows: one label across the gutter, badge and indent (`READ`), in place of both. */
  readonly lead?: Part
  /** Cell 0: the viewpoint's state (meter or state glyph); null = blank. A two-cell glyph takes the badge cell too. */
  readonly gutter: Part | null
  /** Cell 1: the subagent badge; null = blank. */
  readonly badge: (Part & { readonly bg?: string }) | null
  readonly depth: number
  /** `▸`/`▾` on folders, groups and folds; null on files (the slot stays). */
  readonly caret: Part | null
  /** The type icon; null draws nothing (fold rows) but keeps the slot. */
  readonly icon: Part | null
  readonly name: Part & { readonly strike?: boolean; readonly underline?: boolean }
  /** After the name: ✎ ◆ ⚡ ↩n ⟳ ⊘ ?. Kept at every width; the name truncates first. */
  readonly marks: readonly Part[]
  /** Git meta, in order (`+19`, `−5`, `new`…); joined with one space. */
  readonly git: readonly Part[]
  /** The right column's one value; null = blank. */
  readonly value: Part | null
}

/**
 * The right-hand columns' widths. `add` and `del` split the git column for `+N −N` rows: each figure right-aligned in
 * its own sub-column, so `+83 −47` and `+812 −360` line up figure by figure; a word (`new`, `mod`) spans it all.
 */
export type Columns = { readonly git: number; readonly value: number; readonly add?: number; readonly del?: number }

/** What a narrow panel keeps. */
export type Fit = { readonly icons: boolean; readonly git: 'full' | 'short' | 'none' }

/** Narrowest name the drop order protects. */
export const MIN_NAME = 12
/** Below this many panel columns the drop order starts. */
export const NARROW = 52
/** State cell, a space, the badge cell, a space: a Nerd glyph drawn wide never touches the badge. */
const GUTTER = 4
/** The caret slot: caret and a space. */
const SLOT = 2
/** The icon slot: icon and two spaces, so an icon a non-Mono font draws 2 cells wide still clears the name. */
const ICON = 3
/** Cells per tree level: wide enough that a child's name sits clearly right of its folder's. */
export const INDENT = 3
/** Cells between the name (and marks), the git column and the value column. */
const GAP = 2

/** How wide a git part list draws in each mode. */
function gitText(git: readonly Part[], mode: Fit['git']): readonly Part[] {
  if (mode === 'none' || git.length === 0) return []
  return mode === 'short' ? git.slice(0, 1) : git
}

const joinedWidth = (parts: readonly Part[]) => (parts.length === 0 ? 0 : parts.reduce((n, p) => n + cellWidth(p.text), 0) + parts.length - 1)

/** A row's git parts as the `+N` and `−N` figures, or null when they are anything else (a word, a count). */
function figures(git: readonly Part[]): { add: Part; del: Part | null } | null {
  const [a, d] = git
  if (!a || !a.text.startsWith('+') || git.length > 2) return null
  if (d && !d.text.startsWith('−')) return null
  return { add: a, del: d ?? null }
}

/** The git and value column widths for a window of rows, in a fit mode. */
export function columnWidths(rows: readonly RowParts[], mode: Fit['git'] = 'full'): Columns {
  let git = 0
  let value = 0
  let add = 0
  let del = 0
  for (const r of rows) {
    const parts = gitText(r.git, mode)
    const f = figures(parts)
    if (f) {
      add = Math.max(add, cellWidth(f.add.text))
      if (f.del) del = Math.max(del, cellWidth(f.del.text))
    } else git = Math.max(git, joinedWidth(parts))
    value = Math.max(value, r.value ? cellWidth(r.value.text) : 0)
  }
  const pair = add > 0 ? add + (del > 0 ? 1 + del : 0) : 0
  return { git: Math.max(git, pair), value, ...(add > 0 ? { add, del } : {}) }
}

/**
 * The fit for a window: full at ≥ NARROW columns; below, drop the icon, then shorten git meta, then drop it,
 * each only while the deepest visible row's name would get fewer than MIN_NAME cells.
 */
export function fitFor(rows: readonly RowParts[], width: number): Fit {
  if (width >= NARROW) return { icons: true, git: 'full' }
  const fits = (fit: Fit) => rows.every((r) => nameRoom(r, width, columnWidths(rows, fit.git), fit) >= Math.min(MIN_NAME, cellWidth(r.name.text)))
  const order: Fit[] = [
    { icons: false, git: 'full' },
    { icons: false, git: 'short' },
  ]
  for (const f of order) if (fits(f)) return f
  return { icons: false, git: 'none' }
}

function marksWidth(marks: readonly Part[]): number {
  return marks.reduce((n, m) => n + 1 + cellWidth(m.text), 0)
}

/** Cells left for the name after every other part of the row. */
function nameRoom(r: RowParts, width: number, cols: Columns, fit: Fit): number {
  const right = (cols.git > 0 ? cols.git + GAP : 0) + (cols.value > 0 ? cols.value + GAP : 0)
  return width - GUTTER - INDENT * r.depth - SLOT - (fit.icons ? ICON : 0) - marksWidth(r.marks) - right
}

/** Lays out one row exactly `width` cells wide. */
/**
 * Lays out one row exactly `width` cells wide. `fluid` (desktop): the name is never cut here and the padding after it
 * is always there, however narrow; the surface's proportional text is narrower than its cells, so its name Box
 * shrinks (with an ellipsis) only when the row truly runs out of room.
 */
export function layoutRow(r: RowParts, width: number, cols: Columns, fit: Fit = { icons: true, git: 'full' }, fluid = false): Segment[] {
  const out: Segment[] = []
  if (r.lead) {
    // One run across the gutter, the indent and both slots, so a label wider than the gutter in a proportional font
    // still has room before the name column.
    const span = GUTTER + INDENT * r.depth + SLOT + (fit.icons ? ICON : 0)
    const lead = takeCells(r.lead.text, span - 1)
    out.push({ ...seg(r.lead), text: lead + ' '.repeat(span - cellWidth(lead)) })
  } else {
    // Gutter: state, space, badge, space. A two-cell state glyph (`⚡`) takes the state cell and its space.
    const gutterW = r.gutter ? cellWidth(r.gutter.text) : 0
    out.push(r.gutter ? { ...seg(r.gutter), text: r.gutter.text + (gutterW >= 2 ? '' : ' ') } : { text: '  ' })
    out.push(r.badge ? { ...seg(r.badge), ...(r.badge.bg ? { bg: r.badge.bg } : {}) } : { text: ' ' })
    out.push({ text: ' '.repeat(1 + INDENT * r.depth) })
  }
  if (!r.lead) {
    out.push(r.caret ? { ...seg(r.caret), text: r.caret.text + ' ' } : { text: '  ' })
    // The icon and its two spaces; a two-cell icon (plain `⚡`) keeps one.
    if (fit.icons) out.push(r.icon ? { ...seg(r.icon), text: r.icon.text + ' '.repeat(ICON - cellWidth(r.icon.text)) } : { text: ' '.repeat(ICON) })
  }

  const room = Math.max(1, nameRoom(r, width, cols, fit))
  const nameW = cellWidth(r.name.text)
  const name = fluid || nameW <= room ? r.name.text : takeCells(r.name.text, room - 1) + '…'
  out.push({ ...seg(r.name), text: name, name: true, ...(r.name.strike ? { strike: true } : {}), ...(r.name.underline ? { underline: true } : {}) })
  for (const m of r.marks) out.push({ text: ' ' }, seg(m))

  // Pad to the git column, then the value column, right-aligned in each.
  const git = gitText(r.git, fit.git)
  const used = out.reduce((n, s) => n + cellWidth(s.text), 0)
  const right = (cols.git > 0 ? cols.git + GAP : 0) + (cols.value > 0 ? cols.value + GAP : 0)
  out.push({ text: ' '.repeat(Math.max(0, width - used - right)), filler: true })
  if (cols.git > 0) {
    const f = figures(git)
    if (f && cols.add) {
      // `+N` right-aligned in the add sub-column, `−N` in the del sub-column, both at the git column's right end.
      const del = cols.del ?? 0
      out.push({ text: ' '.repeat(GAP + cols.git - cols.add - (del > 0 ? 1 + del : 0)) })
      out.push({ text: ' '.repeat(cols.add - cellWidth(f.add.text)) }, { ...seg(f.add), right: true })
      if (del > 0) {
        out.push({ text: ' ' }, { text: ' '.repeat(del - (f.del ? cellWidth(f.del.text) : 0)) })
        if (f.del) out.push({ ...seg(f.del), right: true })
      }
    } else {
      out.push({ text: ' '.repeat(GAP + cols.git - joinedWidth(git)) })
      git.forEach((g, i) => out.push(...(i > 0 ? [{ text: ' ' }] : []), { ...seg(g), right: true }))
    }
  }
  if (cols.value > 0) {
    out.push({ text: ' '.repeat(GAP + cols.value - (r.value ? cellWidth(r.value.text) : 0)) })
    if (r.value) out.push({ ...seg(r.value), right: true })
  }
  return fluid ? out.filter((s) => s.text !== '' || s.filler) : clip(out, width)
}

function seg(p: Part): Segment {
  return { text: p.text, ...(p.fg ? { fg: p.fg } : {}), ...(p.bold ? { bold: true } : {}) }
}

/** Never wider than `width`: a row whose fixed parts overflow (a tiny pane) loses its right edge. */
function clip(segs: Segment[], width: number): Segment[] {
  const out: Segment[] = []
  let left = width
  for (const s of segs) {
    if (left <= 0) break
    const w = cellWidth(s.text)
    if (w <= left) {
      out.push(s)
      left -= w
    } else {
      // A two-cell glyph on the edge doesn't fit: pad the cell it leaves.
      const t = takeCells(s.text, left)
      out.push({ ...s, text: t + ' '.repeat(left - cellWidth(t)) })
      left = 0
    }
  }
  if (left > 0) out.push({ text: ' '.repeat(left) })
  return out.filter((s) => s.text !== '')
}

/**
 * Lays out a visible window: one fit and one set of column widths for every row, so the columns line up. `head`
 * rows (the column header, the totals) take the same columns and widen them when their labels need it.
 */
export function layoutWindow(rows: readonly RowParts[], width: number, head: readonly RowParts[] = [], o: { headRoom?: number; fluid?: boolean } = {}): Segment[][] {
  const fit = fitFor(rows, width)
  const own = columnWidths(rows, fit.git)
  const heads = columnWidths(head, fit.git)
  // `headRoom` > 1 where text is proportional: capitals in the header run past one cell each.
  const room = (n: number) => Math.ceil(n * (o.headRoom ?? 1))
  const add = Math.max(own.add ?? 0, heads.add ?? 0)
  const del = Math.max(own.del ?? 0, heads.del ?? 0)
  const pair = add > 0 ? add + (del > 0 ? 1 + del : 0) : 0
  const cols = { git: Math.max(own.git, room(heads.git), pair), value: Math.max(own.value, room(heads.value)), ...(add > 0 ? { add, del } : {}) }
  return [...head, ...rows].map((r) => layoutRow(r, width, cols, fit, o.fluid))
}
