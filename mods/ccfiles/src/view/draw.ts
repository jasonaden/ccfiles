// Rows and lines → colored segments exactly as wide as the pane: the read
// fill is the background of the first round(coverage × width) cells,
// subtle by default (palette `fill.darkness`).
import { RECEDING, contrastRatio, dimFillBackground, fillBackground, mix, readableOn, type ColorKey, type Palette } from '../palette.ts'
import type { DetailLine } from './detail.ts'
import { isClaudeCodeLoad, type Chip, type Lit, type Row } from './rows.ts'
import { basename } from '../paths.ts'
import type { Band, RowLine, Seg } from '../../hooks/rows.ts'
import { cellWidth, fillColumns, fitRow, splitAt, wrapSegments, type Segment } from './text.ts'
import { layoutWindow, type Part, type RowParts } from './anatomy.ts'
import { glyphVector, type Vector } from './svg.ts'
import * as icons from './icons.ts'
import { GLYPHS } from './glyphs.ts'
import type { GlyphSet } from './icons.ts'
import { fmtDate, fmtSize, type ValueMode } from './values.ts'
import { ESTIMATE_MARKER, fmtEstTokens } from '../tokens.ts'

const color = (p: Palette, key: ColorKey) => p.colors[key]

function chips(p: Palette, cs: readonly Chip[], sep = ' '): Segment[] {
  const out: Segment[] = []
  cs.forEach((c, i) => {
    if (i > 0 && c.tag) out.push({ text: sep })
    out.push({ text: (i > 0 && !c.tag ? sep : '') + c.text, fg: color(p, c.color), ...(c.tag ? { tag: true } : {}) })
  })
  return out
}

/** A list row: indent, a two-cell glyph slot, the name, right-aligned meta, the fill under the first cells. */
export function rowSegments(row: Row, width: number, p: Palette, selected: boolean): Segment[] {
  const glyph = row.glyph ? row.glyph.text + ' '.repeat(Math.max(0, 2 - cellWidth(row.glyph.text))) : '  '
  const left: Segment[] = [
    { text: '  '.repeat(row.depth) },
    { text: glyph + ' ', fg: row.glyph ? color(p, row.glyph.color) : undefined },
    // The selected row's name is underlined too, so the selection shows on a fully filled row.
    { text: row.label, name: true, fg: color(p, row.tone), bold: row.lit !== null || row.pending || row.kind === 'group' ? true : undefined, ...(selected ? { underline: true } : {}), ...(row.strike ? { strike: true } : {}) },
  ]
  const segs = fitRow(left, rightSide(row, p), width)
  const rowBg = selected ? p.colors.selection : undefined
  const fill = fillColumns(row.coverage, width)
  const painted = fill === 0 ? (rowBg ? segs.map((s) => ({ ...s, bg: rowBg })) : segs) : splitAt(segs, fill, rowFill(row, p), rowBg)
  // C1: every name and meta stays at 4.5:1 on its fill or the selection, in truecolor and in tmux's 256 colours.
  // Receding colours (muted, git.ignored) are held to 3:1, except on a selected row.
  const receding = new Set(RECEDING.map((k) => p.colors[k]))
  const min = (fg: string) => (!selected && receding.has(fg) ? 3 : 4.5)
  return painted.map((s) => (s.fg && s.text.trim() !== '' ? { ...s, fg: readableOn(s.fg, s.bg ?? p.background, p, min(s.fg)) } : s))
}

/** The row's right side in the fallback layout (surfaces without the rows Client): its meta. */
function rightSide(row: Row, p: Palette): Segment[] {
  return chips(p, row.meta)
}

/** The background of a row's filled part: its state tint, toned down when the row is out of context. */
function rowFill(row: Row, p: Palette): string {
  return (row.dim ? dimFillBackground : fillBackground)(p, row.fillTone ?? 'read')
}

/** Segments as the rows Client draws them (hooks/rows.ts), each with its width in cells for the grid. */
export function clientSegs(segs: readonly Segment[]): Seg[] {
  return segs.map((s) => ({ t: s.text, w: cellWidth(s.text), ...(s.fg ? { c: s.fg } : {}), ...(s.bg ? { bg: s.bg } : {}), ...(s.bold ? { b: true } : {}), ...(s.underline ? { u: true } : {}), ...(s.strike ? { s: true } : {}), ...(s.right ? { r: true } : {}), ...(s.name ? { n: true } : {}), ...(s.filler ? { f: true } : {}) }))
}

/**
 * One list row for the rows Client: its exact-width segments, its press id, and while a read, edit or commit runs
 * the shimmer on its tag: `sh` the state, `at` the tag's characters, `ph` the row's own phase (rows in flight
 * together shimmer out of step, not as one moving block).
 */
export function rowLine(row: Row, width: number, p: Palette, selected: boolean, id = row.key): RowLine {
  const segs = rowSegments(row, width, p, selected)
  // `at` counts code points, as the Client walks the text.
  let col = 0
  let at: [number, number] | null = null
  for (const s of segs) {
    const w = [...s.text].length
    if (s.tag) at = at ? [at[0], col + w] : [col, col + w]
    col += w
  }
  return { id, segs: clientSegs(segs), ...(row.shimmer && at ? { sh: row.shimmer, at, ph: phaseOf(row.key) } : {}) }
}

/** A stable per-row phase offset in ticks. */
function phaseOf(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 997
}

/** How far each band step sits from the panel background toward the state colour (darkest first). */
const BAND_STEPS = [0.4, 0.6, 0.8, 1]

/**
 * The shimmer band per state, 4 steps from the edge to the middle: backgrounds rising from the panel
 * background to the state colour, each with the text color (the panel's text or background) that reads better on it.
 * Every step keeps clear of the background and the fills in 256 colours too (tests/shimmer.test.ts).
 */
export function shimmerBands(p: Palette): Record<Lit, Band[]> {
  const bands = {} as Record<Lit, Band[]>
  for (const lit of ['read', 'search', 'edit', 'commit', 'instruction'] as const) {
    bands[lit] = BAND_STEPS.map((t) => {
      const bg = mix(p.background, p.colors[lit], t)
      return { bg, fg: contrastRatio(p.colors.text, bg) >= contrastRatio(p.background, bg) ? p.colors.text : p.background }
    })
  }
  return bands
}

/** A detail line, wrapped to the width (one or more screen lines); a table row's wrap hangs under its second column. */
export function lineSegments(line: DetailLine, width: number, p: Palette): Segment[][] {
  if (line.length === 0) return [fitRow([], [], width)]
  const head = line[0]!
  const indent = cellWidth(head.text)
  // A first column wider than half the pane leaves too little room to hang under: wrap to the edge instead.
  if (!head.hang || indent * 2 > width) return wrapSegments(chips(p, line, ''), width)
  return wrapSegments(chips(p, line.slice(1), ''), width - indent).map((l, i) => [i === 0 ? { text: head.text, fg: color(p, head.color) } : { text: ' '.repeat(indent) }, ...l])
}


// ---- Row anatomy ----------------------------------------------------------------------------

/** How the list looks beyond the palette: icon set, the right column's form, file facts for date/size. */
export type Look = {
  readonly glyphs: GlyphSet
  readonly value: ValueMode
  readonly now: number
  /** Size and modified time of a file or folder from the walk; undefined when unknown. */
  readonly info?: (path: string) => { readonly size: number; readonly mtimeMs: number } | undefined
  /** Colour file icons by language (nvim-web-devicons), else `muted`. */
  readonly iconColor?: 'muted' | 'language'
  /** `meter` (default) draws coverage as a gutter glyph; `fill` keeps the row tint as well. */
  readonly coverage?: 'meter' | 'fill'
  /** `off` (reduced motion): a working file's name holds its state colour instead of shimmering. */
  readonly motion?: 'on' | 'off'
  /** Gutter cell 1, the other agents that touched a file (`live` while one works on it). */
  readonly badge?: (path: string) => { readonly text: string; readonly live: boolean } | null
  /** ≈ tokens other agents read of a file the viewpoint didn't: drawn `(≈N)`, outside the viewpoint's totals. */
  readonly others?: (path: string) => number
}

/** The meter's colour: the latest of an edit and a commit, a Claude Code load, else read. */
function meterColor(row: Row): ColorKey {
  const f = row.file
  if (f?.instruction && f.instruction.mode !== 'tool' && (f.lastAction === null || f.lastAction === 'autoload')) return 'instruction'
  return row.fillTone ?? 'read'
}

/** Cell 0 for a file: the meter when its coverage is known and it was read, else its state glyph. */
function gutterOf(row: Row, look: Look): { text: string; color: ColorKey } | null {
  const g = row.kind === 'file' || row.kind === 'skill' ? row.glyph : (row.cells?.gutter ?? null)
  if (!g) return null
  const read = g.text === GLYPHS.full.glyph || g.text === GLYPHS.partial.glyph
  if (read && row.coverage !== null) return { text: icons.meterGlyph(row.coverage, look.glyphs), color: meterColor(row) }
  if (read) return { text: icons.meterGlyph(g.text === GLYPHS.full.glyph ? 1 : 0.25, look.glyphs), color: meterColor(row) }
  return g
}

const CARET_KINDS = new Set<Row['kind']>(['dir', 'fold', 'group', 'plugin', 'section'])

/** The ≈ figure without the `tok` suffix: the column needs no unit (the `≈` stays). */
function tokenValue(n: number): string {
  return fmtEstTokens(n).replace(/ tok$/, '')
}

/** The right column's value for a row in the current form. */
function valueOf(row: Row, look: Look): string | null {
  const c = row.cells
  switch (look.value) {
    case 'tokens': {
      if (c && c.tokens === null && row.kind === 'file' && row.path) {
        const o = look.others?.(row.path) ?? 0
        return o > 0 ? `(${tokenValue(o)})` : null
      }
      if (c) return c.tokens !== null ? tokenValue(c.tokens) : null
      const m = row.meta.find((x) => x.text.startsWith(ESTIMATE_MARKER))
      return m ? m.text.replace(/ tok$/, '') : null
    }
    case 'lines':
      return c?.lines ?? null
    case 'date': {
      const i = row.path ? look.info?.(row.path) : undefined
      return i && i.mtimeMs > 0 ? fmtDate(i.mtimeMs, look.now) : null
    }
    case 'size': {
      const i = row.kind === 'file' && row.path ? look.info?.(row.path) : undefined
      return i ? fmtSize(i.size) : null
    }
  }
}

/** The badge chip: bold letter on a dim chip, so it reads without colour; brighter while that agent works on it. */
function badgeOf(row: Row, p: Palette, look: Look): RowParts['badge'] {
  const b = row.kind === 'file' && row.path ? look.badge?.(row.path) : null
  if (!b) return null
  return { text: b.text, fg: b.live ? p.background : color(p, 'text'), bold: true, bg: b.live ? color(p, 'read') : color(p, 'selection') }
}

/** A Row as anatomy parts, coloured from the palette. */
export function rowParts(row: Row, p: Palette, look: Look, selected: boolean): RowParts {
  const caret = CARET_KINDS.has(row.kind) && row.glyph ? { text: row.glyph.text, fg: color(p, 'muted') } : null
  const gutterChip = gutterOf(row, look)
  let icon: RowParts['icon'] = null
  if (row.kind === 'dir') icon = { text: icons.icon(row.expanded ? 'folderOpen' : 'folder', look.glyphs), fg: color(p, row.tone === 'muted' ? 'muted' : 'accent') }
  else if (row.kind === 'section' && row.key === 's:loads') icon = { text: icons.icon('system', look.glyphs), fg: color(p, 'instruction') }
  else if (row.kind === 'section') icon = { text: icons.icon('repo', look.glyphs), fg: color(p, 'accent') }
  else if (row.kind === 'file' && row.file && isClaudeCodeLoad(row.file)) icon = { text: icons.icon('system', look.glyphs), fg: color(p, 'instruction') }
  else if (row.kind === 'file' && row.path) {
    const ic = icons.fileIcon(basename(row.path), look.glyphs)
    icon = { text: ic.g, fg: look.iconColor === 'language' && ic.c ? ic.c : color(p, 'muted') }
  }
  // With plain glyphs the system icon is `⚡` itself: the mark would repeat it.
  const systemIcon = icon !== null && icon.text === icons.icon('system', look.glyphs)
  const marks = (row.cells ? row.cells.marks : []).filter((m) => !(systemIcon && look.glyphs === 'plain' && m.text === GLYPHS.auto.glyph))
  const git = row.cells ? row.cells.git : []
  const value = valueOf(row, look)
  return {
    gutter: gutterChip ? { text: gutterChip.text, fg: color(p, gutterChip.color) } : null,
    badge: badgeOf(row, p, look),
    depth: row.depth,
    caret,
    icon,
    name: {
      text: row.label,
      fg: color(p, row.tone),
      ...(row.lit !== null || row.pending || row.kind === 'group' || row.kind === 'section' ? { bold: true } : {}),
      ...(row.strike ? { strike: true } : {}),
      ...(selected ? { underline: true } : {}),
    },
    marks: marks.map((m) => ({ text: m.text, fg: color(p, m.color) })),
    git: git.map((m) => ({ text: m.text, fg: color(p, m.color) })),
    value: value ? { text: value, fg: color(p, 'muted') } : null,
  }
}

/**
 * The visible window as rows Client lines: one fit and one set of column widths for all rows, the
 * selection's background, the read fill (when coverage is drawn as a fill), readable text on both, and the name shimmer.
 */
export function windowLines(rows: readonly Row[], width: number, p: Palette, look: Look, selectedKey: string | undefined): RowLine[] {
  return listLines(rows, width, p, look, selectedKey).rows
}

/** What sits above the rows on the same columns: the column names and the totals row. */
export type ListHead = {
  /** The totals row's label (`All files · 16 touched`); null = no totals row. */
  readonly label: string | null
  /** Git lines added and removed over every changed file. */
  readonly git: { readonly added: number; readonly removed: number } | null
  /** The right column's total, already formatted (`≈22k`). */
  readonly value: string | null
}

/** The right column's name in each form. */
const VALUE_HEADING: Record<Look['value'], string> = { tokens: '≈TOKENS', lines: 'LINES', date: 'MODIFIED', size: 'SIZE' }

/**
 * The list as rows Client lines, with the column header and totals rows on the same columns when `head` is given.
 * `vectors`: the gutter glyphs are drawn as vectors over the list (desktop), so their cells stay blank here and
 * `glyphs` holds each row's drawing.
 */
export function listLines(
  rows: readonly Row[],
  width: number,
  p: Palette,
  look: Look,
  selectedKey: string | undefined,
  o: { head?: ListHead; vectors?: boolean } = {},
): { head: RowLine[]; rows: RowLine[]; glyphs: (Vector | null)[] } {
  const still = look.motion === 'off'
  const parts = rows.map((r) => {
    const x = rowParts(r, p, look, r.key === selectedKey)
    return still && r.shimmer ? { ...x, name: { ...x.name, fg: color(p, r.shimmer), bold: true } } : x
  })
  const heads = o.head ? headParts(o.head, p, look, parts.some((x) => x.git.length > 0)) : []
  const all = layoutWindow(parts, width, heads, o.vectors ? { headRoom: 1.3, fluid: true } : {})
  const head = all.slice(0, heads.length).map((segs) => ({ id: '', segs: clientSegs(segs) }))
  const laid = all.slice(heads.length)
  const glyphs = parts.map((x, i) => {
    if (!o.vectors || !x.gutter) return null
    const v = glyphVector(x.gutter.text, x.gutter.fg ?? p.colors.read, rows[i]!.coverage)
    // The vector takes the glyph's cells; the text there goes blank.
    if (v) laid[i] = laid[i]!.map((s, k) => (k === 0 ? { ...s, text: ' '.repeat(cellWidth(s.text)) } : s))
    return v
  })
  const lines = rows.map((row, i) => {
    const segs = laid[i]!
    const rowBg = row.key === selectedKey ? p.colors.selection : undefined
    const fill = look.coverage === 'fill' ? fillColumns(row.coverage, width) : 0
    const painted = fill === 0 ? (rowBg ? segs.map((s) => ({ ...s, bg: rowBg })) : segs) : splitAt(segs, fill, rowFill(row, p), rowBg)
    const selected = row.key === selectedKey
    const readable = painted.map((s) => (s.fg && s.text.trim() !== '' ? { ...s, fg: readableOn(s.fg, s.bg ?? p.background, p, !selected && receding(p, s.fg) ? 3 : 4.5) } : s))
    // While a read, edit or commit runs, the band crosses the name's characters.
    let col = 0
    let at: [number, number] | null = null
    for (const s of readable) {
      const w = [...s.text].length
      if (s.name) at = at ? [at[0], col + w] : [col, col + w]
      col += w
    }
    return { id: row.key, segs: clientSegs(readable), ...(row.shimmer && at && !still ? { sh: row.shimmer, at, ph: phaseOf(row.key) } : {}) }
  })
  return { head, rows: lines, glyphs }
}

/** The column header and the totals row as anatomy parts. The git heading shows when any row or the totals has git. */
function headParts(h: ListHead, p: Palette, look: Look, rowsHaveGit: boolean): RowParts[] {
  const muted = color(p, 'muted')
  const git: Part[] = h.git && h.git.added + h.git.removed > 0 ? [{ text: `+${h.git.added}`, fg: color(p, 'added') }, { text: `−${h.git.removed}`, fg: color(p, 'removed') }] : []
  const blank = { gutter: null, badge: null, depth: 0, caret: null, icon: null, marks: [] } as const
  const out: RowParts[] = [
    { ...blank, lead: { text: 'READ', fg: muted }, name: { text: 'NAME', fg: muted }, git: rowsHaveGit || git.length > 0 ? [{ text: 'GIT', fg: muted }] : [], value: { text: VALUE_HEADING[look.value], fg: muted } },
  ]
  if (h.label !== null) out.push({ ...blank, name: { text: h.label, fg: muted }, git, value: h.value ? { text: h.value, fg: color(p, 'text'), bold: true } : null })
  return out
}

/** A colour that recedes on purpose (`muted`, `git.ignored`): held to 3:1, not 4.5:1, off the selection. */
function receding(p: Palette, fg: string): boolean {
  return RECEDING.some((k) => p.colors[k] === fg)
}
