// The panel's own state (tab, selection, expansion, scroll, follow, search,
// detail) and the pure moves the keys, the mouse and the scroll events make.
import { dirname } from '../paths.ts'
import { ancestors, type Row, type SortKey, type Tab } from './rows.ts'

export type PanelState = {
  tab: Tab
  /** Selected row key per tab. */
  selected: Record<Tab, string | null>
  /** First list row shown per tab. */
  offset: Record<Tab, number>
  /**
   * Expanded dir paths and `u:<dir>` folds (Tree), and `p:<plugin>` groups (Instructions). Some keys mean closed
   * instead: `x:<dir>` (an outside section's folder, open by default), `r:<root>` and `t:<root>` (outside sections).
   */
  expanded: Set<string>
  query: string
  sort: SortKey
  /** Keep the latest activity in view; a manual scroll or move pauses it. */
  follow: boolean
  /** The file whose detail view is open (state key), HELP for the help view, or null. */
  detail: string | null
  detailOffset: number
  /** `⊟` pressed: every folder closed, drawn `⊞` until pressed again or a folder is opened by hand. */
  collapsed: boolean
  /** The agents line expanded into its list, the list's own scroll, and the `×N` groups opened. */
  agentsOpen: boolean
  agentsScroll: number
  agentGroups: Set<string>
  /** The folder the Tree shows (view only), or null for the session root. */
  focus: string | null
  /** The viewpoint: `main` or a subagent id (`a` steps through them). */
  agent: string
}

export function initialPanel(): PanelState {
  return {
    tab: 'tree',
    selected: { tree: null, touched: null, instructions: null },
    offset: { tree: 0, touched: 0, instructions: 0 },
    expanded: new Set(),
    query: '',
    sort: 'recent',
    follow: true,
    detail: null,
    detailOffset: 0,
    collapsed: false,
    agentsOpen: false,
    agentsScroll: 0,
    agentGroups: new Set(),
    focus: null,
    agent: 'main',
  }
}


const SORTS: readonly SortKey[] = ['recent', 'tokens', 'coverage']

export function nextSort(s: SortKey): SortKey {
  return SORTS[(SORTS.indexOf(s) + 1) % SORTS.length]!
}

function indexOf(rows: readonly Row[], key: string | null): number {
  return key === null ? -1 : rows.findIndex((r) => r.key === key)
}

export function selectedRow(p: PanelState, rows: readonly Row[]): Row | null {
  return rows[indexOf(rows, p.selected[p.tab])] ?? null
}

/** Keeps row `i` inside the window of `height` rows. */
function keepVisible(p: PanelState, i: number, height: number): void {
  const off = p.offset[p.tab]
  if (i < off) p.offset[p.tab] = i
  else if (i >= off + height) p.offset[p.tab] = i - height + 1
}

/** j/k: moves the selection by `delta` rows (from the top when nothing is selected). */
export function move(p: PanelState, rows: readonly Row[], delta: number, height: number): void {
  if (rows.length === 0) return
  const at = indexOf(rows, p.selected[p.tab])
  const i = Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? p.offset[p.tab] : p.offset[p.tab] + height - 1) : at + delta))
  p.selected[p.tab] = rows[i]!.key
  p.follow = false
  keepVisible(p, i, height)
}

/** Selects a row by key (a click) without scrolling. */
export function select(p: PanelState, key: string): void {
  p.selected[p.tab] = key
}

/** The `expanded` key a row's open state reads: a folder's path (`x:<path>` for one open by default), else its key. */
function openKey(row: Row): string {
  if (row.kind !== 'dir' || !row.path) return row.key
  return row.openByDefault ? `x:${row.path}` : row.path
}

/** Enter / click: a folder, plugin group or untouched fold toggles, a file opens its detail view. */
export function activate(p: PanelState, row: Row): void {
  p.selected[p.tab] = row.key
  const key = openKey(row)
  if ((row.kind === 'dir' && row.path) || row.kind === 'plugin' || row.kind === 'fold' || row.kind === 'section') toggle(p.expanded, key)
  else if (row.kind === 'file' && row.path) openDetail(p, row.path)
  // Opening a folder by hand clears `⊞`; the folders stay as they are. An `x:` key set means closed.
  if ((row.kind === 'dir' || row.kind === 'fold') && p.expanded.has(key) !== (row.openByDefault === true)) p.collapsed = false
}

/** h: collapses the selected folder, or moves to the folder holding the selection. */
export function collapse(p: PanelState, rows: readonly Row[], height: number): void {
  const i = indexOf(rows, p.selected[p.tab])
  const row = rows[i]
  if (!row) return
  if ((row.kind === 'dir' || row.kind === 'plugin' || row.kind === 'fold' || row.kind === 'section') && row.expanded) {
    // Some rows are open unless their key is set (outside sections and their touched folders): flip the
    // key rather than delete it. A search holds every folder open; there `h` only forgets an opened one.
    const key = openKey(row)
    if (row.openByDefault) {
      if (p.query === '') p.expanded.add(key)
    } else if (p.expanded.has(key) || (p.query !== '' && (row.kind === 'dir' || row.kind === 'plugin'))) p.expanded.delete(key)
    else p.expanded.add(key)
    return
  }
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j]!.depth < row.depth) {
      p.selected[p.tab] = rows[j]!.key
      keepVisible(p, j, height)
      return
    }
  }
}

/** l: expands the selected folder, or opens the selected file's detail. */
export function expand(p: PanelState, rows: readonly Row[]): void {
  const row = selectedRow(p, rows)
  if (!row) return
  // Flip only a closed row: an open-by-default one is opened by clearing its key.
  if ((row.kind === 'dir' && row.path) || row.kind === 'plugin' || row.kind === 'fold' || row.kind === 'section') {
    if (!row.expanded) toggle(p.expanded, openKey(row))
  } else if (row.kind === 'file' && row.path) openDetail(p, row.path)
  if (row.kind === 'dir' || row.kind === 'fold') p.collapsed = false
}

/**
 * `⊟` / `⊞`: the first press closes every folder and fold; the second returns to the default view, the
 * ancestors of `paths` (touched and git-changed files) open, untouched siblings folded. Outside sections' folders are
 * open by default: the first press closes those above `paths` outside `root` (`x:` keys), the second clears them.
 * Section headers, Instructions groups and Touched groups keep their state.
 */
export function toggleCollapse(p: PanelState, paths: Iterable<string>, root: string): void {
  for (const k of [...p.expanded]) if (!['p:', 's:', 'r:', 't:'].some((pre) => k.startsWith(pre))) p.expanded.delete(k)
  p.collapsed = !p.collapsed
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root
  for (const path of paths) {
    if (!p.collapsed) reveal(p, path, root)
    else if (path.startsWith('/') && path !== r && !path.startsWith(r + '/')) {
      // Every `x:` key went above: one already set was set with all of its ancestors.
      for (let d = dirname(path); d !== '/' && !p.expanded.has(`x:${d}`); d = dirname(d)) p.expanded.add(`x:${d}`)
    }
  }
  p.offset[p.tab] = 0
}

export function openDetail(p: PanelState, path: string): void {
  p.detail = path
  p.detailOffset = 0
}

/** The `detail` value of the help view (`g`): drawn, scrolled and closed like a detail view. */
export const HELP = 'help:'

export function openHelp(p: PanelState): void {
  openDetail(p, HELP)
}

/** The `detail` value of the agents view (`u`): per-agent ≈ tokens and exact usage. */
export const AGENTS = 'agents:'

export function openAgents(p: PanelState): void {
  openDetail(p, AGENTS)
}

export function closeDetail(p: PanelState): void {
  p.detail = null
}

/**
 * A scroll (wheel, arrows, page keys, Home/End) moved by `by` rows. The
 * person's own scroll pauses follow; the list never scrolls past its end.
 */
export function scroll(p: PanelState, by: number, total: number, height: number, byPerson: boolean): void {
  if (p.detail !== null) {
    p.detailOffset = Math.max(0, p.detailOffset + by)
    return
  }
  p.offset[p.tab] = Math.max(0, Math.min(Math.max(0, total - height), p.offset[p.tab] + by))
  if (byPerson) p.follow = false
}

/** Opens every folder above `path` (follow's reveal; a search hit's jump). */
export function reveal(p: PanelState, path: string, root: string): void {
  for (const d of ancestors(path, root)) p.expanded.add(d)
}

/** Search submit: reveals every hit and selects the first one. */
export function jumpToHits(p: PanelState, rows: readonly Row[], root: string, height: number): void {
  const hits = rows.filter((r) => r.kind === 'file')
  for (const r of hits) if (r.path) reveal(p, r.path, root)
  const first = hits[0]
  if (!first) return
  p.selected[p.tab] = first.key
  p.follow = false
  keepVisible(p, rows.indexOf(first), height)
}

function toggle(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}

/** The activity follow keeps in view: a pending row first, else the most recently lit. */
export function followTarget(rows: readonly Row[]): number {
  let best = -1
  let bestTs = -Infinity
  rows.forEach((r, i) => {
    const ts = r.pending ? Infinity : r.lit ? (r.file?.lastTs ?? 0) : -Infinity
    if (ts > bestTs) {
      best = i
      bestTs = ts
    }
  })
  return bestTs === -Infinity ? -1 : best
}

export type ListWindow = {
  readonly rows: readonly Row[]
  /** How many rows the window shows (one less than the list area when a note line is drawn under it). */
  readonly height: number
  /** Rows outside the window; > 0 draws one fixed note line under it. */
  readonly hidden: number
  /** Of those, rows in flight or lit: counted on the note, never pinned as rows. */
  readonly active: number
}

/**
 * The rows the list area of `height` lines shows. With follow on, the latest activity is moved into view
 * (centered). A list longer than the area always gives its last line to one note (`⋮ 21 more · 3 active`), so the
 * window keeps its size while lights come and go: the list never jumps.
 */
export function listWindow(p: PanelState, rows: readonly Row[], height: number): ListWindow {
  if (height <= 0) return { rows: [], height: 0, hidden: 0, active: 0 }
  const h = rows.length > height && height > 1 ? height - 1 : height
  const maxOffset = Math.max(0, rows.length - h)
  if (p.follow) {
    const t = followTarget(rows)
    const off = p.offset[p.tab]
    if (t >= 0 && (t < off || t >= off + h)) p.offset[p.tab] = Math.min(maxOffset, Math.max(0, t - Math.floor(h / 2)))
  }
  const off = (p.offset[p.tab] = Math.min(p.offset[p.tab], maxOffset))
  const shown = rows.slice(off, off + h)
  const active = rows.filter((r, i) => (r.lit !== null || r.pending) && (i < off || i >= off + h)).length
  return { rows: shown, height: h, hidden: rows.length - shown.length, active }
}

/**
 * Where the pane's focus ring goes after its own press or a search Enter: the selected row when it is drawn,
 * else the header's `?` Button, which every layout draws (list, detail, help), so the pane keeps the keyboard; a
 * one-glyph button shows the ring as a small mark instead of inverting a tab.
 * Not a hidden hotkey Button: a ring on a zero-width element drops the keys back to the prompt.
 * Rows drawn by the rows Client are not focus-ring stops (only Buttons, Inputs and Selects are).
 */
export function focusTarget(p: PanelState, rows: readonly Row[], rowsAreButtons = true): string {
  const sel = p.detail === null && rowsAreButtons ? p.selected[p.tab] : undefined
  return sel && rows.some((r) => r.key === sel) ? sel : 'btn:help'
}
