// The chrome around the list: the branch row, the tab strip's labels and the one-line footer.
// Pure: each returns colour keys, never hex, and fits its width by dropping parts in a fixed order.
import type { GitSnapshot } from '../git.ts'
import type { ColorKey } from '../palette.ts'
import type { Tab } from './rows.ts'
import { cellWidth, truncateMiddle } from './text.ts'
import { fmtEstTokens, fmtExactTokens } from '../tokens.ts'

export type Piece = { readonly text: string; readonly color: ColorKey; readonly bold?: boolean }

const width = (ps: readonly Piece[]) => ps.reduce((n, p) => n + cellWidth(p.text), 0)
const sp: Piece = { text: ' ', color: 'muted' }
const join = (groups: readonly (readonly Piece[])[], sep: Piece = sp): Piece[] => groups.filter((g) => g.length > 0).flatMap((g, i) => (i > 0 ? [sep, ...g] : [...g]))

/** Counts of changed files by kind, ignoring ignored files. */
export function gitCounts(git: GitSnapshot): { added: number; removed: number; fresh: number; mod: number; del: number; ren: number } {
  const out = { added: 0, removed: 0, fresh: 0, mod: 0, del: 0, ren: 0 }
  for (const f of git.files.values()) {
    if (f.letter === '!') continue
    out.added += f.added
    out.removed += f.removed
    if (f.letter === '?' || f.letter === 'A') out.fresh++
    else if (f.letter === 'M') out.mod++
    else if (f.letter === 'D') out.del++
    else if (f.letter === 'R') out.ren++
  }
  return out
}

/**
 * The branch row: `⎇ main ↑4 ↓1 origin/main` left, `+223 −21 · 4 new · 6 mod · 1 del` right. Narrow:
 * the upstream drops first, then the per-state counts, then `+N −N`; `⎇ branch ↑N ↓N` stays. `branchGlyph` is the
 * icon without its trailing space.
 */
export function branchRow(git: GitSnapshot, w: number, opts: { branchGlyph?: string; upstream?: string | null; lines?: boolean } = {}): { left: Piece[]; right: Piece[] } {
  // Two spaces after the icon, as on the rows: a Nerd glyph drawn wide still clears the name.
  const name: Piece[] = [{ text: `${opts.branchGlyph ?? '⎇'}  `, color: 'accent' }, { text: git.branch ?? 'detached', color: 'text', bold: true }]
  const track: Piece[] = [...(git.ahead ? [{ text: ` ↑${git.ahead}`, color: 'search' as const }] : []), ...(git.behind ? [{ text: ` ↓${git.behind}`, color: 'git.M' as const }] : [])]
  const upstream: Piece[] = opts.upstream ? [{ text: ` ${opts.upstream}`, color: 'muted' }] : []
  const c = gitCounts(git)
  const lines: Piece[] = opts.lines !== false && c.added + c.removed > 0 ? [{ text: `+${c.added}`, color: 'added' }, sp, { text: `−${c.removed}`, color: 'removed' }] : []
  const states: Piece[][] = [
    c.fresh ? [{ text: `${c.fresh} new`, color: 'git.A' }] : [],
    c.mod ? [{ text: `${c.mod} mod`, color: 'git.M' }] : [],
    c.del ? [{ text: `${c.del} del`, color: 'git.D' }] : [],
    c.ren ? [{ text: `${c.ren} ren`, color: 'git.R' }] : [],
  ]
  const dot: Piece = { text: ' · ', color: 'muted' }
  const clean = c.added + c.removed + c.fresh + c.mod + c.del + c.ren === 0 ? [{ text: 'clean', color: 'muted' as const }] : []
  const tries: { left: Piece[]; right: Piece[] }[] = [
    { left: [...name, ...track, ...upstream], right: join([lines, ...states, clean], dot) },
    { left: [...name, ...track], right: join([lines, ...states, clean], dot) },
    { left: [...name, ...track], right: join([lines, clean], dot) },
    { left: [...name, ...track], right: [] },
  ]
  for (const t of tries) if (width(t.left) + (t.right.length ? 1 + width(t.right) : 0) <= w) return t
  return tries[tries.length - 1]!
}

export type TabLabel = { readonly tab: Tab; readonly label: string; readonly count: number | null }

/** Cells a tab takes: its label and count, padded one cell each side. */
export function tabWidth(t: TabLabel): number {
  return 2 + cellWidth(t.label) + (t.count !== null ? 1 + String(t.count).length : 0)
}

/**
 * The tab strip's labels: `Tree`, `Touched 6`, `Instructions 6`, then the search control. Narrow:
 * the search control shrinks to its glyph, then `Instructions` shortens to `Instr`.
 */
export function tabStrip(counts: { touched: number; instructions: number }, w: number, search: { full: string; glyph: string }): { tabs: TabLabel[]; search: string } {
  const tabs = (instr: string): TabLabel[] => [
    { tab: 'tree', label: 'Tree', count: null },
    { tab: 'touched', label: 'Touched', count: counts.touched },
    { tab: 'instructions', label: instr, count: counts.instructions },
  ]
  const used = (ts: TabLabel[], s: string) => ts.reduce((n, t) => n + tabWidth(t), 0) + 1 + cellWidth(s)
  for (const [instr, s] of [['Instructions', search.full], ['Instructions', search.glyph], ['Instr', search.glyph]] as const) {
    if (used(tabs(instr), s) <= w) return { tabs: tabs(instr), search: s }
  }
  return { tabs: tabs('Instr'), search: search.glyph }
}

/** The footer: whose context it is and how big, the share that came from files, and the keys this view takes. */
export type Footer = {
  /** Line 1: `main agent  218k in context (exact)` left, `≈22k from files` right. */
  readonly top: { readonly left: Piece[]; readonly right: Piece[] }
  /** The files' share of the context (0–1) for the bar under it; null until a request reports a context. */
  readonly share: number | null
  /** The bar's label: `10% of context`. */
  readonly shareLabel: string | null
  /** Last line: the keys for this view left (`j k move · d detail`), the activity chip right. */
  readonly bottom: { readonly left: Piece[]; readonly right: Piece[] }
}

/** One key and what it does, as the footer lists it. */
export type KeyHint = readonly [keys: string, does: string]

/**
 * The footer for a viewpoint. `context` is exact (the last request's input, from the API's usage report); `files`
 * is the estimate of the file text in it. Narrow: the wording shortens, then `who` drops, then `files`; the context
 * figure never drops. Keys drop from the end, the chip shortens and then drops.
 */
export function footerBlock(
  o: { who: string; context: number | null; files: number; chip: { full: string; short: string; color: ColorKey } | null; keys: readonly KeyHint[] },
  w: number,
): Footer {
  const ctx = o.context === null ? null : fmtExactTokens(o.context, { short: true }).replace(/^=/, '')
  const files = fmtEstTokens(o.files).replace(/ tok$/, '')
  const who: Piece = { text: o.who, color: 'accent', bold: true }
  const fig = (t: string): Piece => ({ text: t, color: 'text', bold: true })
  const m = (t: string): Piece => ({ text: t, color: 'muted' })
  const tops: { left: Piece[]; right: Piece[] }[] =
    ctx === null
      ? [
        { left: [who, m('  no request yet')], right: [fig(files), m(' from files')] },
        { left: [who], right: [fig(files), m(' files')] },
        { left: [], right: [fig(files), m(' files')] },
      ]
      : [
        { left: [who, m('  '), fig(ctx), m(' in context (exact)')], right: [fig(files), m(' from files')] },
        { left: [who, m('  '), fig(ctx), m(' exact')], right: [fig(files), m(' files')] },
        { left: [fig(ctx), m(' context, exact')], right: [fig(files), m(' files')] },
        { left: [fig(ctx), m(' exact')], right: [fig(files)] },
        { left: [fig(ctx), m(' exact')], right: [] },
      ]
  const fits = (t: { left: Piece[]; right: Piece[] }) => width(t.left) + (t.right.length ? 1 + width(t.right) : 0) <= w
  const top = tops.find(fits) ?? tops[tops.length - 1]!
  const share = o.context !== null && o.context > 0 ? Math.min(1, o.files / o.context) : null
  const keyPieces = (ks: readonly KeyHint[]): Piece[] => ks.flatMap(([k, d], i) => [...(i > 0 ? [m(' · ')] : []), { text: k, color: 'text' as const }, m(` ${d}`)])
  const chip = (t: string): Piece[] => (o.chip ? [{ text: t, color: o.chip.color }] : [])
  let bottom = { left: keyPieces(o.keys), right: chip(o.chip?.full ?? '') }
  for (let n = o.keys.length; n >= 0; n--) {
    for (const c of [o.chip?.full ?? '', o.chip?.short ?? '', '']) {
      bottom = { left: keyPieces(o.keys.slice(0, n)), right: c ? chip(c) : [] }
      if (fits(bottom)) return { top, share, shareLabel: share === null ? null : `${Math.round(share * 100)}% of context`, bottom }
    }
  }
  return { top, share, shareLabel: share === null ? null : `${Math.round(share * 100)}% of context`, bottom: { left: [], right: [] } }
}
