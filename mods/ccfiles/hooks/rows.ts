// The panel's list, drawn by a Client surface module (R1, R2): rows the hooks module already laid out to the
// exact pane width (src/view/draw.ts), plus what only a client can do well: hover, click and drag-to-scroll
// without a hook round trip, and a shimmer band across the whole row of the file Claude is reading or editing.
// Structure after data-goblin/claude-code-filetree hooks/rows.tsx (MIT, see ACKNOWLEDGEMENTS.md); our own code.
// Self-contained: a surface module runs on the drawing thread and imports nothing at run time.
import type { ClientModule } from 'claude-code'

/**
 * One run of text: `c` color, `bg` background, `b` bold, `u` underline, `s` strikethrough; `w` its width in cells,
 * `r` right-aligned within them; `n` the name, sized to its text; `f` the padding after it, which stretches (all
 * read only on the grid).
 */
export type Seg = { t: string; c?: string; bg?: string; b?: boolean; u?: boolean; s?: boolean; w?: number; r?: boolean; n?: boolean; f?: boolean }

/** One step of the shimmer band: the background it paints and the text color that reads on it. */
export type Band = { bg: string; fg: string }

/**
 * One drawn line, exactly the pane's width. `id` is what a press or copy names (a row key; '' = not pressable).
 * `sh`: the characters `at` ([from, to), code points) — the row's in-progress tag — shimmer with the band `bands[sh]` (4 steps, edge
 * first), `ph` ticks out of step with other rows.
 */
export type RowLine = { id: string; segs: Seg[]; sh?: string; at?: [number, number]; ph?: number }

export type RowsProps = {
  lines: RowLine[]
  /** Background under a hovered pressable row (segments without their own background). */
  hoverBg: string
  /** The panel's background, painted under every segment without its own (a light panel over a dark terminal); absent = the terminal's. */
  bg?: string
  bands: Record<string, Band[]>
  /**
   * Draw each run in a Box exactly `w` cells wide: a surface whose text is not monospace (desktop) still lines
   * the columns up, since a Box's width counts cells there too. Bars of block characters draw as filled cells.
   */
  grid?: boolean
}

/** What the module posts to the hooks module (`ui.message`, element `rows`). */
export type RowsMessage = { press: string } | { copy: string } | { scrollBy: number } | { key: string; ctrl?: boolean; shift?: boolean }

type Local = { hover: number; phase: number; drag: { y: number; moved: boolean } | null; ref: { stop?: () => void } }

const TICK_MS = 90
/** Rows the grid sweeps at once (see the render). */
const SWEPT_MAX = 12
/** Ticks one sweep across the tag takes (~1 s). */
const SWEEP_TICKS = 12

/** The band step over cell `col` of a `width`-cell tag at `phase`: 3 = the middle, 0 = its edge, -1 = none. */
function bandStep(col: number, phase: number, width: number): number {
  const span = width + 8
  const d = Math.abs(col - ((((phase * span) / SWEEP_TICKS) % span) - 4))
  return d < 1 ? 3 : d < 2 ? 2 : d < 3 ? 1 : d < 4 ? 0 : -1
}

/** How much of its cell a block element fills from the left (negative: from the right); 0 = not a block. */
function blockShare(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0x2588) return 1
  if (cp >= 0x2589 && cp <= 0x258f) return (0x2590 - cp) / 8
  if (cp === 0x2595) return -1 / 8
  return 0
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { hover: -1, phase: 0, drag: null, ref: {} }
    surface.setState(state)
  }
  // Animate only while a row shimmers (no repeating timer when idle).
  const lit = props.lines.some((l) => l.sh)
  if (lit && !state.ref.stop) {
    state.ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!lit && state.ref.stop) {
    state.ref.stop()
    state.ref.stop = undefined
  }

  surface.onPointer((e) => {
    const cur = surface.state ?? state!
    const line = e.y >= 0 && e.y < props.lines.length ? props.lines[e.y] : undefined
    if (e.type === 'leave') {
      if (cur.hover !== -1 || cur.drag) surface.setState({ ...cur, hover: -1, drag: null })
      return
    }
    if (e.type === 'down' && e.button === 'right') {
      if (line?.id) surface.post({ copy: line.id } satisfies RowsMessage)
      return
    }
    if (e.type === 'down' && (e.button ?? 'left') === 'left') {
      surface.setState({ ...cur, drag: { y: e.y, moved: false } })
      return
    }
    if (e.type === 'move' && cur.drag) {
      // Drag-to-scroll: the list follows the pointer, one row per cell moved.
      const by = cur.drag.y - e.y
      if (by !== 0) {
        surface.post({ scrollBy: by } satisfies RowsMessage)
        surface.setState({ ...cur, hover: -1, drag: { y: e.y, moved: true } })
      }
      return
    }
    if (e.type === 'up') {
      const drag = cur.drag
      surface.setState({ ...cur, drag: null })
      // A double-click is timed by the hooks module with the engine clock: the drawing thread's
      // Date did not tick reliably live.
      if (drag && !drag.moved && line?.id) surface.post({ press: line.id } satisfies RowsMessage)
      return
    }
    if (e.type === 'move') {
      const hover = line?.id ? e.y : -1
      if (hover !== cur.hover) surface.setState({ ...cur, hover })
    }
  })
  surface.onKey((e) => surface.post({ key: e.key, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}) } satisfies RowsMessage))

  const phase = state.phase
  // On the grid the row Box paints the row's background; a run paints only its own.
  // A name split into sweep runs sits in a Box sized to them: the runs need no truncation of their own (and the
  // Client's tree stays small); a whole name truncates with an ellipsis when its Box shrinks.
  const text = (s: Seg, bg: string | undefined, whole = true) =>
    Text({ ...(s.c ? { color: s.c } : {}), ...((s.bg ?? (props.grid ? undefined : bg)) ? { backgroundColor: s.bg ?? bg } : {}), ...(s.b ? { bold: true } : {}), ...(s.u ? { underline: true } : {}), ...(s.s ? { strikethrough: true } : {}), ...(props.grid && s.n && !whole ? {} : { wrap: 'truncate' as const }), children: [s.t] })
  /** On the grid: the run's own cells, right-aligned when `r`, its background across all of them. */
  // A name takes its text's own width, so a proportional font never cuts it at its cell count; the padding after it
  // stretches to the next column, which keeps the columns where the cells put them.
  const size = (s: Seg) => (s.n ? { flexShrink: 1 } : s.f ? { width: 0, flexGrow: 1, flexShrink: 1 } : { width: s.w ?? [...s.t].length, flexShrink: 0 })
  const cells = (s: Seg, bg: string | undefined, children: ReturnType<typeof Text>[]) =>
    Box({ ...size(s), ...(s.n ? { overflow: 'hidden' as const } : {}), ...(s.r || children.length > 1 ? { flexDirection: 'row' as const } : {}), ...(s.r ? { justifyContent: 'flex-end' } : {}), ...(s.bg ? { backgroundColor: s.bg } : {}), children })
  /** A bar of block characters as filled cells: the font's own block glyphs leave gaps between letters. */
  const bar = (s: Seg) =>
    [...s.t].map((ch) => {
      const share = blockShare(ch)
      if (share === 0) return Box({ width: 1, flexShrink: 0, children: [Text({ ...(s.c ? { color: s.c } : {}), children: [ch] })] })
      const fill = Box({ width: `${Math.round(Math.abs(share) * 100)}%`, height: 1, ...(s.c ? { backgroundColor: s.c } : {}) })
      return Box({ width: 1, height: 1, flexShrink: 0, flexDirection: 'row', ...(share < 0 ? { justifyContent: 'flex-end' } : {}), children: [fill] })
    })
  const seg = (s: Seg, bg: string | undefined) => {
    if (!props.grid) return text(s, bg)
    // A blank run draws no text: its Box holds the cells (and its own background, if any).
    if (blank(s)) return Box({ width: s.w ?? [...s.t].length, flexShrink: 0, ...(s.bg ? { backgroundColor: s.bg } : {}) })
    // The stretching padding after a name holds no text either.
    if (s.f) return Box(size(s))
    return cells(s, bg, [...s.t].some((ch) => blockShare(ch) !== 0) ? bar(s) : [text(s, bg)])
  }
  const blank = (s: Seg) => !s.n && !s.f && !s.u && !s.s && /^ *$/.test(s.t)
  /**
   * The grid's runs with the blanks folded into their neighbours: padding before a right-aligned run joins it, other
   * padding joins the run before it (a column's room, not a box of its own). Fewer boxes keep the Client's tree
   * small, and a right-aligned heading gets its padding's room, so it isn't cut at its cell count.
   */
  const folded = (segs: readonly Seg[]): Seg[] => {
    const out: Seg[] = []
    let carry = 0
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!
      const w = s.w ?? [...s.t].length
      if (blank(s) && !s.bg) {
        const next = segs[i + 1]
        const prev = out[out.length - 1]
        if (next?.r) carry += w
        else if (prev && !prev.r && !prev.n && !prev.f && !prev.bg) out[out.length - 1] = { ...prev, w: (prev.w ?? [...prev.t].length) + w }
        else out.push({ ...s, w })
        continue
      }
      out.push(carry ? { ...s, w: w + carry } : s)
      carry = 0
    }
    return out
  }
  // On the grid a sweeping name costs a Text per band step: past SWEPT_MAX rows in flight at once, the rest hold
  // their state colour (the hooks module colours them) instead of sweeping, so the tree stays under the size limit.
  let swept_ = 0
  return Box({
    flexDirection: 'column',
    children: props.lines.map((l, i) => {
      const bg = l.id && i === state!.hover ? props.hoverBg : props.bg
      const band = l.sh && (!props.grid || swept_++ < SWEPT_MAX) ? props.bands[l.sh] : undefined
      if (!band) return Box({ flexDirection: 'row', height: 1, overflow: 'hidden', ...(props.grid && bg ? { backgroundColor: bg } : {}), children: (props.grid ? folded(l.segs) : l.segs).map((s) => seg(s, bg)) })
      // The band crosses the tag's cells only: runs of cells with one band step; the rest as laid out.
      const [from, to] = l.at ?? [0, 0]
      /** One run's characters from column `start` on, split where the band's step changes. */
      const swept = (s: Seg, start: number) => {
        const runs: ReturnType<typeof Text>[] = []
        let run = ''
        let runStep = -2
        let c = start
        const flush = () => {
          if (run === '') return
          const b = runStep >= 0 ? band[runStep] : undefined
          runs.push(text(b ? { ...s, t: run, c: b.fg, bg: b.bg } : { ...s, t: run }, bg, false))
          run = ''
        }
        for (const ch of s.t) {
          const step = c >= from && c < to ? bandStep(c - from, phase + (l.ph ?? 0), to - from) : -1
          c++
          if (step !== runStep) flush()
          runStep = step
          run += ch
        }
        flush()
        return runs
      }
      if (props.grid) {
        // On the grid the band sweeps the name (the tag); the rest folds as on any row.
        let at = 0
        for (const s of l.segs) {
          if (s.n) break
          at += [...s.t].length
        }
        return Box({ flexDirection: 'row', height: 1, overflow: 'hidden', ...(bg ? { backgroundColor: bg } : {}), children: folded(l.segs).map((s) => (s.n ? cells(s, bg, swept(s, at)) : seg(s, bg))) })
      }
      // The terminal: each run split where the band's step changes, in its own columns.
      const children: ReturnType<typeof Text>[] = []
      let col = 0
      for (const s of l.segs) {
        children.push(...swept(s, col))
        col += [...s.t].length
      }
      return Box({ flexDirection: 'row', height: 1, overflow: 'hidden', children })
    }),
  })
}

export default Rows
