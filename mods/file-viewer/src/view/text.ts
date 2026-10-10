// Terminal text for the panel: cell widths, truncation, compact numbers, and
// rows built from colored segments padded to an exact width, so the read fill
// can cover exactly round(coverage × width) cells.

/** A run of text with one style. Colors are '#rrggbb' or theme keys. */
export type Segment = {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly underline?: boolean
  /** Struck through: a deleted file's name. */
  readonly strike?: boolean
  /** Part of a row's name (where the name starts, for alignment). */
  readonly name?: boolean
  /** The in-progress tag: the only cells that shimmer. */
  readonly tag?: boolean
}

/** Cells one code point takes: 0 for combining marks, 2 for wide (CJK, emoji presentation like ⚡), else 1. */
export function charWidth(cp: number): number {
  if (cp >= 0x300 && cp <= 0x36f) return 0
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    cp === 0x26a1 ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2
  }
  return 1
}

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += charWidth(ch.codePointAt(0)!)
  return n
}

/** The longest prefix of `s` that fits in `w` cells. */
export function takeCells(s: string, w: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!)
    if (n + cw > w) break
    out += ch
    n += cw
  }
  return out
}

function takeCellsEnd(s: string, w: number): string {
  const chars = [...s]
  let out = ''
  let n = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!.codePointAt(0)!)
    if (n + cw > w) break
    out = chars[i] + out
    n += cw
  }
  return out
}

/** Fits `s` in `w` cells, cutting the middle (`src/com…name.ts`): paths keep their start and file name. */
export function truncateMiddle(s: string, w: number): string {
  if (cellWidth(s) <= w) return s
  if (w <= 1) return takeCells('…', w)
  const right = Math.floor((w - 1) / 2)
  const left = w - 1 - right
  return takeCells(s, left) + '…' + takeCellsEnd(s, right)
}

/** Approximate line count for row meta: `40`, `1.3k`, `12k`. */
export function fmtLines(n: number | null): string {
  if (n === null) return '?'
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Cells the read fill covers: round(coverage × width). */
export function fillColumns(coverage: number | null, width: number): number {
  if (coverage === null || width <= 0) return 0
  return Math.max(0, Math.min(width, Math.round(coverage * width)))
}

export function segmentsWidth(segs: readonly Segment[]): number {
  return segs.reduce((n, s) => n + cellWidth(s.text), 0)
}

/** Cuts segments to `w` cells; the last kept segment ends in `…` when anything was cut. */
function clip(segs: readonly Segment[], w: number): Segment[] {
  if (segmentsWidth(segs) <= w) return [...segs]
  const out: Segment[] = []
  let room = w - 1
  for (const s of segs) {
    if (room <= 0) break
    const t = takeCells(s.text, room)
    if (t) out.push({ ...s, text: t })
    room -= cellWidth(t)
    if (t !== s.text) break
  }
  const last = out[out.length - 1]
  out.push({ text: '…', fg: last?.fg, dim: last?.dim })
  return out
}

/**
 * One row exactly `w` cells wide: `left` (clipped first) then spaces then
 * `right` flush with the edge. The right side is dropped only when it alone
 * doesn't fit.
 */
export function fitRow(left: readonly Segment[], right: readonly Segment[], w: number): Segment[] {
  const rw = segmentsWidth(right)
  const keepRight = right.length > 0 && rw + 2 <= w
  const room = keepRight ? w - rw - 1 : w
  const l = clip(left, room)
  const gap = w - segmentsWidth(l) - (keepRight ? rw : 0)
  return [...l, { text: ' '.repeat(Math.max(0, gap)) }, ...(keepRight ? right : [])].filter((s) => s.text !== '')
}

/** Gives the first `n` cells background `bg` (and the rest `rest`), splitting a segment at the boundary; a wide character stays whole. */
export function splitAt(segs: readonly Segment[], n: number, bg: string, rest?: string): Segment[] {
  const out: Segment[] = []
  let col = 0
  for (const s of segs) {
    const w = cellWidth(s.text)
    if (col >= n || col + w <= n) {
      out.push(withBg(s, col < n ? bg : rest))
    } else {
      const head = takeCells(s.text, n - col)
      const tail = s.text.slice(head.length)
      if (head) out.push(withBg({ ...s, text: head }, bg))
      if (tail) out.push(withBg({ ...s, text: tail }, rest))
    }
    col += w
  }
  return out
}

function withBg(s: Segment, bg: string | undefined): Segment {
  if (bg === undefined) {
    const { bg: _drop, ...rest } = s
    return rest
  }
  return { ...s, bg }
}

/** Hard-wraps segments into lines of at most `w` cells, breaking at the last space when one is near. */
export function wrapSegments(segs: readonly Segment[], w: number): Segment[][] {
  const lines: Segment[][] = [[]]
  let col = 0
  for (const s of segs) {
    let rest = s.text
    while (rest !== '') {
      const room = w - col
      if (cellWidth(rest) <= room) {
        lines[lines.length - 1]!.push({ ...s, text: rest })
        col += cellWidth(rest)
        break
      }
      let head = takeCells(rest, room)
      const space = head.lastIndexOf(' ')
      if (space > room / 2) head = head.slice(0, space + 1)
      if (head !== '') lines[lines.length - 1]!.push({ ...s, text: head })
      rest = rest.slice(head.length)
      lines.push([])
      col = 0
    }
  }
  return lines.map((l) => fitRow(l, [], w))
}
