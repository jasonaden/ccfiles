// The panel's list, drawn by a Client surface module (R1, R2): rows the hooks module already laid out to the
// exact pane width (src/view/draw.ts), plus what only a client can do well: hover, click and drag-to-scroll
// without a hook round trip, and a shimmer band across the whole row of the file Claude is reading or editing.
// Structure after data-goblin/claude-code-filetree hooks/rows.tsx (MIT, see ACKNOWLEDGEMENTS.md); our own code.
// Self-contained: a surface module runs on the drawing thread and imports nothing at run time.
import type { ClientModule } from 'claude-code'

/** One run of text: `c` color, `bg` background, `b` bold, `u` underline, `s` strikethrough. */
export type Seg = { t: string; c?: string; bg?: string; b?: boolean; u?: boolean; s?: boolean }

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
}

/** What the module posts to the hooks module (`ui.message`, element `rows`). */
export type RowsMessage = { press: string } | { copy: string } | { scrollBy: number } | { key: string; ctrl?: boolean; shift?: boolean }

type Local = { hover: number; phase: number; drag: { y: number; moved: boolean } | null; ref: { stop?: () => void } }

const TICK_MS = 90
/** Ticks one sweep across the tag takes (~1 s). */
const SWEEP_TICKS = 12

/** The band step over cell `col` of a `width`-cell tag at `phase`: 3 = the middle, 0 = its edge, -1 = none. */
function bandStep(col: number, phase: number, width: number): number {
  const span = width + 8
  const d = Math.abs(col - ((((phase * span) / SWEEP_TICKS) % span) - 4))
  return d < 1 ? 3 : d < 2 ? 2 : d < 3 ? 1 : d < 4 ? 0 : -1
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
  const seg = (s: Seg, bg: string | undefined) =>
    Text({ ...(s.c ? { color: s.c } : {}), ...((s.bg ?? bg) ? { backgroundColor: s.bg ?? bg } : {}), ...(s.b ? { bold: true } : {}), ...(s.u ? { underline: true } : {}), ...(s.s ? { strikethrough: true } : {}), wrap: 'truncate', children: [s.t] })
  return Box({
    flexDirection: 'column',
    children: props.lines.map((l, i) => {
      const bg = l.id && i === state!.hover ? props.hoverBg : props.bg
      const band = l.sh ? props.bands[l.sh] : undefined
      if (!band) return Box({ flexDirection: 'row', height: 1, overflow: 'hidden', children: l.segs.map((s) => seg(s, bg)) })
      // The band crosses the tag's cells only: runs of cells with one band step; the rest as laid out.
      const [from, to] = l.at ?? [0, 0]
      const children: ReturnType<typeof Text>[] = []
      let col = 0
      for (const s of l.segs) {
        let run = ''
        let runStep = -2
        const flush = () => {
          if (run === '') return
          const b = runStep >= 0 ? band[runStep] : undefined
          children.push(seg(b ? { ...s, t: run, c: b.fg, bg: b.bg } : { ...s, t: run }, bg))
          run = ''
        }
        for (const ch of s.t) {
          const c = col++
          const step = c >= from && c < to ? bandStep(c - from, phase + (l.ph ?? 0), to - from) : -1
          if (step !== runStep) flush()
          runStep = step
          run += ch
        }
        flush()
      }
      return Box({ flexDirection: 'row', height: 1, overflow: 'hidden', children })
    }),
  })
}

export default Rows
