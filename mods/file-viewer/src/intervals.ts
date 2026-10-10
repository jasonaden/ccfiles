// Line-range sets: sorted, merged, 1-based inclusive [start, end] pairs.

export type Range = readonly [start: number, end: number]

/** One hunk of a structured patch, in the old file's coordinates plus its new size. */
export type Hunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** The diff lines (` ` context, `-` removed, `+` added); absent in older logs. */
  readonly lines?: readonly string[]
}

/** Returns a new set with `range` added; overlapping and adjacent ranges merge. */
export function addRange(set: readonly Range[], range: Range): Range[] {
  return normalize([...set, range])
}

/** Sorts and merges any list of ranges; drops empty ones (end < start). */
export function normalize(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** How many of lines 1..total the set covers. */
export function coveredLines(set: readonly Range[], total: number): number {
  let n = 0
  for (const [a, b] of set) {
    const lo = Math.max(a, 1)
    const hi = Math.min(b, total)
    if (hi >= lo) n += hi - lo + 1
  }
  return n
}

/** Covered share of the file, 0..1; null when the total is unknown. */
export function coverageRatio(set: readonly Range[], total: number | null): number | null {
  if (total === null) return null
  if (total === 0) return 1
  return coveredLines(set, total) / total
}

export function isFull(set: readonly Range[], total: number | null): boolean {
  return total !== null && coveredLines(set, total) === total
}

/** `1–200, 250, 300–349` */
export function formatRanges(set: readonly Range[]): string {
  // Grouped like the totals they sit next to: `1–1,325 / 1,325`.
  const n = (x: number) => x.toLocaleString('en-US')
  return set.map(([a, b]) => (a === b ? n(a) : `${n(a)}–${n(b)}`)).join(', ')
}

/**
 * Moves a set through an edit: lines after a hunk move by the hunk's net size,
 * lines inside a hunk stay inside its new extent, deleted lines drop out.
 */
export function shiftForHunks(set: readonly Range[], hunks: readonly Hunk[]): Range[] {
  if (hunks.length === 0) return normalize(set)
  const sorted = [...hunks].sort((x, y) => x.oldStart - y.oldStart)
  return normalize(set.map(([a, b]) => [mapLine(a, sorted, 'start'), mapLine(b, sorted, 'end')] as const))
}

// Uses old coordinates and net sizes only: a zero-length side's `start` is
// off by one under the unified-diff convention, so `newStart` is not trusted.
function mapLine(line: number, hunks: readonly Hunk[], edge: 'start' | 'end'): number {
  let delta = 0
  for (const h of hunks) {
    if (h.oldLines === 0) {
      // Pure insertion after line `oldStart`.
      if (line <= h.oldStart) break
      delta += h.newLines
      continue
    }
    if (line < h.oldStart) break
    if (line < h.oldStart + h.oldLines) {
      if (h.newLines === 0) return edge === 'start' ? h.oldStart + delta : h.oldStart - 1 + delta
      return h.oldStart + delta + Math.min(line - h.oldStart, h.newLines - 1)
    }
    delta += h.newLines - h.oldLines
  }
  return line + delta
}

/** `set` minus `remove`. */
export function subtract(set: readonly Range[], remove: readonly Range[]): Range[] {
  let out = normalize(set)
  for (const [x, y] of normalize(remove)) {
    out = out.flatMap(([a, b]): Range[] => {
      if (y < a || x > b) return [[a, b]]
      const parts: Range[] = []
      if (a < x) parts.push([a, x - 1])
      if (b > y) parts.push([y + 1, b])
      return parts
    })
  }
  return out
}

/**
 * Maps a covered set through an edit, line by line inside each hunk:
 * unchanged lines keep coverage at their new numbers, removed lines drop, and
 * context lines Claude never saw stay uncovered. `added` is the lines the
 * edit wrote (new coordinates). Hunks without `lines` fall back to the net shift.
 */
export function applyPatch(set: readonly Range[], hunks: readonly Hunk[]): { kept: Range[]; added: Range[] } {
  if (hunks.some((h) => !h.lines)) return { kept: shiftForHunks(set, hunks), added: [] }
  const covered = normalize(set)
  const kept: Range[] = []
  const added: Range[] = []
  const keep = (a: number, b: number, delta: number) => {
    for (const [x, y] of covered) {
      const lo = Math.max(a, x)
      const hi = Math.min(b, y)
      if (hi >= lo) kept.push([lo + delta, hi + delta])
    }
  }
  let cursor = 1
  let delta = 0
  for (const h of [...hunks].sort((p, q) => p.oldStart - q.oldStart)) {
    // A zero-length side's start names the line before it (unified diff).
    let o = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart
    let n = h.newLines === 0 ? h.newStart + 1 : h.newStart
    keep(cursor, o - 1, delta)
    for (const line of h.lines!) {
      if (line.startsWith('+')) {
        added.push([n, n])
        n++
      } else if (line.startsWith('-')) {
        o++
      } else if (line.startsWith(' ')) {
        keep(o, o, n - o)
        o++
        n++
      }
    }
    cursor = o
    delta = n - o
  }
  keep(cursor, Number.MAX_SAFE_INTEGER, delta)
  return { kept: normalize(kept), added: normalize(added) }
}
