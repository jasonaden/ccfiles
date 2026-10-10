// Subagents in the list. The gutter badge (cell 1), the one-line agents line under the tab
// strip, its expanded list (capped at a third of the body, scrolling on its own) and the viewpoint step. Pure: built
// on the registry and per-agent tracks `src/agents.ts` already keeps; returns text with semantic roles, not colours.
import { agentTable, MAIN } from '../agents.ts'
import type { FileState, SessionState } from '../model.ts'
import { fmtEstTokens } from '../tokens.ts'
import { cellWidth, takeCells } from './text.ts'

/** `E` Explore, `G` general-purpose, `P` Plan, `C` custom, `m` main (in a subagent viewpoint), `+` two or more kinds. */
export type Badge = 'E' | 'G' | 'P' | 'C' | 'm' | '+'

/** One agent as the agents line and its list show it. Main has key and type `main` and no status. */
export type AgentInfo = {
  readonly key: string
  readonly type: string
  /** The registry label: `Explore#7`, `db-migrator#1`. */
  readonly label: string
  readonly status: 'running' | 'done' | null
  readonly end: number | null
  /** Files it read, searched, edited or loaded. */
  readonly files: readonly string[]
  /** ≈ tokens (chars ÷ 4) of what it read and loaded. */
  readonly estTokens: number
  readonly description: string | null
}

export type AgentRole =
  | 'caret'
  | 'main'
  | 'sep'
  | 'gap'
  | 'badge'
  | 'name'
  | 'count'
  | 'custom'
  | 'running'
  | 'done'
  | 'files'
  | 'tokens'
  | 'description'
  | 'more'
  | 'total'

/** A run of text and what it is; `key` names the agent a click on it selects; `selected` marks the viewpoint. */
export type AgentSeg = { readonly text: string; readonly role: AgentRole; readonly key?: string; readonly selected?: boolean }

const TYPE_BADGE: Readonly<Record<string, Badge>> = { main: 'm', Explore: 'E', 'general-purpose': 'G', Plan: 'P' }

/** The letter for one agent type; any type not built in is custom (`C`). */
export function typeBadge(type: string): Badge {
  return TYPE_BADGE[type] ?? 'C'
}

/**
 * Gutter cell 1: the agents other than the viewpoint that touched the file. One kind (any number of agents) → its
 * letter; two or more kinds → `+`; none → null. Main is a kind of its own (`m`), seen only from a subagent viewpoint.
 */
export function badgeFor(touchers: readonly { readonly key: string; readonly type: string }[], viewpoint: string): Badge | null {
  const kinds = new Set(touchers.filter((t) => t.key !== viewpoint).map((t) => typeBadge(t.type)))
  if (kinds.size === 0) return null
  return kinds.size === 1 ? [...kinds][0]! : '+'
}

/** `badgeFor` over a file's per-agent tracks; agents the registry doesn't know (Claude Code's forks) are skipped. */
export function fileBadge(f: FileState, s: SessionState, viewpoint: string): Badge | null {
  const touchers: { key: string; type: string }[] = []
  for (const key of f.byAgent.keys()) {
    if (key === MAIN) touchers.push({ key, type: 'main' })
    else {
      const a = s.registry.get(key)
      if (a) touchers.push({ key, type: a.type })
    }
  }
  return badgeFor(touchers, viewpoint)
}

/** Main, then each subagent in registry (start) order, with the figures `agentTable` gives the help view. */
export function agentInfos(s: SessionState): AgentInfo[] {
  const table = agentTable(s)
  return table.rows.map((r) => {
    const a = s.registry.get(r.key)
    const files: string[] = []
    // Files it worked on: read, searched, edited or wrote, or a file Claude Code loaded for it. Not listings, and not
    // the skill descriptions every agent's context starts with (they would count every installed skill).
    for (const [p, f] of s.files) {
      const t = f.byAgent.get(r.key)
      if (!t || p.startsWith('skill-description:')) continue
      if (t.reads + t.hits + t.edits + t.writes + t.loads > 0) files.push(p)
    }
    return {
      key: r.key,
      type: r.key === MAIN ? 'main' : (a?.type ?? ''),
      label: r.label,
      status: r.key === MAIN ? null : r.status,
      end: r.end,
      files,
      estTokens: r.estTokens,
      description: a?.description ?? null,
    }
  })
}

/** `a` / a click: main → each subagent in order → main. An unknown current viewpoint goes back to main. */
export function nextViewpoint(current: string, agents: readonly string[]): string {
  const order = [MAIN, ...agents.filter((k) => k !== MAIN)]
  return order[(order.indexOf(current) + 1) % order.length]!
}

/** The label without `#1` when it is the only agent of its type (`db-migrator`), else as registered (`Explore#7`). */
function shortName(a: AgentInfo, all: readonly AgentInfo[]): string {
  if (a.key === MAIN) return 'main'
  const same = all.filter((x) => x.type === a.type).length
  return same === 1 ? a.label.replace(/#\d+$/, '') : a.label
}

const statusGlyph = (s: 'running' | 'done') => (s === 'running' ? '◌' : '✓')

/** `≈41k`: the right-column form, no `tok` suffix; always marked as an estimate. */
function est(n: number): string {
  return fmtEstTokens(n).replace(/ tok$/, '')
}

function width(segs: readonly AgentSeg[]): number {
  return segs.reduce((n, s) => n + cellWidth(s.text), 0)
}

/** Cuts to `w` cells, ending in `…` when anything was cut, then pads with spaces to exactly `w`. */
function fit(segs: readonly AgentSeg[], w: number): AgentSeg[] {
  let out: AgentSeg[] = [...segs]
  if (width(out) > w) {
    out = []
    let room = Math.max(0, w - 1)
    for (const s of segs) {
      const t = takeCells(s.text, room)
      if (t) out.push({ ...s, text: t })
      room -= cellWidth(t)
      if (t !== s.text) break
    }
    if (w > 0) out.push({ text: '…', role: out[out.length - 1]?.role ?? 'gap' })
  }
  const pad = w - width(out)
  return pad > 0 ? [...out, { text: ' '.repeat(pad), role: 'gap' }] : out
}

/** Running agents in start order, then finished ones, most recently finished first; the viewpoint's agent leads. */
function lineOrder(agents: readonly AgentInfo[], viewpoint: string): AgentInfo[] {
  const subs = agents.filter((a) => a.key !== MAIN)
  const running = subs.filter((a) => a.status !== 'done')
  const done = subs.filter((a) => a.status === 'done').sort((a, b) => (b.end ?? 0) - (a.end ?? 0))
  const order = [...running, ...done]
  const vp = order.findIndex((a) => a.key === viewpoint)
  return vp > 0 ? [order[vp]!, ...order.slice(0, vp), ...order.slice(vp + 1)] : order
}

/**
 * The collapsed (or, with `expanded`, the list's header) agents line, exactly `width` cells:
 * `▸ main · C db-migrator ◌ · E Explore#7 ◌ · +9 done   ≈41k`. Running agents first, then finished ones while they
 * fit, the rest folded into `+N done` (and `+N running` when even running agents don't fit; just `+N` when the
 * words would cost a name); right-aligned the ≈ tokens every agent read, main included. Null when no subagent exists.
 */
export function agentsLine(agents: readonly AgentInfo[], o: { width: number; viewpoint: string; expanded?: boolean }): AgentSeg[] | null {
  if (!agents.some((a) => a.key !== MAIN)) return null
  const items = lineOrder(agents, o.viewpoint)
  const sel = (key: string) => (key === o.viewpoint ? { selected: true } : {})
  const head: AgentSeg[] = [
    { text: o.expanded ? '▾' : '▸', role: 'caret' },
    { text: ' ', role: 'gap' },
    { text: 'main', role: 'main', key: MAIN, ...sel(MAIN) },
  ]
  const item = (a: AgentInfo): AgentSeg[] => {
    const k = { key: a.key, ...sel(a.key) }
    return [
      { text: ' · ', role: 'sep' },
      { text: typeBadge(a.type), role: 'badge', ...k },
      { text: ' ', role: 'gap', ...k },
      { text: shortName(a, agents), role: 'name', ...k },
      { text: ' ', role: 'gap', ...k },
      { text: statusGlyph(a.status ?? 'running'), role: a.status === 'done' ? 'done' : 'running', ...k },
    ]
  }
  const tail = (folded: readonly AgentInfo[], short: boolean): AgentSeg[] => {
    if (folded.length === 0) return []
    if (short) return [{ text: ' · ', role: 'sep' }, { text: `+${folded.length}`, role: 'more' }]
    const run = folded.filter((a) => a.status !== 'done').length
    const done = folded.length - run
    const parts: AgentSeg[] = []
    if (run > 0) parts.push({ text: ' · ', role: 'sep' }, { text: `+${run} running`, role: 'more' })
    if (done > 0) parts.push({ text: ' · ', role: 'sep' }, { text: `+${done} done`, role: 'more' })
    return parts
  }
  const totalText = est(agents.reduce((n, a) => n + a.estTokens, 0))
  const right: AgentSeg[] = [{ text: totalText, role: 'total' }]
  const MIN_GAP = 2
  for (const withTotal of [true, false]) {
    const room = withTotal ? o.width - cellWidth(totalText) - MIN_GAP : o.width
    for (let k = items.length; k >= 0; k--) {
      for (const short of [false, true]) {
        const left = [...head, ...items.slice(0, k).flatMap(item), ...tail(items.slice(k), short)]
        if (width(left) > room) continue
        if (!withTotal) return fit(left, o.width)
        return [...left, { text: ' '.repeat(o.width - width(left) - cellWidth(totalText)), role: 'gap' }, ...right]
      }
    }
  }
  return fit([...head, ...tail(items, true)], o.width)
}

/** One row of the expanded list: an agent (indent 1 under its open group), or finished agents of one type. */
export type AgentListRow =
  | {
      readonly kind: 'agent'
      readonly key: string
      readonly badge: Badge
      readonly name: string
      readonly custom: boolean
      readonly status: 'running' | 'done' | null
      readonly files: number
      readonly estTokens: number
      readonly description: string | null
      readonly indent: 0 | 1
      readonly selected: boolean
    }
  | {
      readonly kind: 'group'
      /** The agent type; what the caller keeps in `open` to open the group. */
      readonly type: string
      readonly badge: Badge
      readonly name: string
      readonly custom: boolean
      readonly count: number
      readonly status: 'done'
      /** Distinct files across its agents. */
      readonly files: number
      readonly estTokens: number
      readonly open: boolean
      /** The viewpoint is one of its agents. */
      readonly selected: boolean
    }

export type AgentList = {
  /** The visible window, at most `cap` rows. */
  readonly rows: AgentListRow[]
  /** The scroll offset used (clamped). */
  readonly offset: number
  /** ⌊bodyHeight / 3⌋: the most rows the list may take; the tree keeps the rest. */
  readonly cap: number
  /** Rows in the whole list. */
  readonly total: number
  readonly above: boolean
  readonly below: boolean
}

/**
 * The expanded list: main, then running agents (their own rows, at the top), then finished agents most recent
 * first, where two or more finished agents of one type fold into one `×N` group row that opens (its type in `open`)
 * to its instances. Windowed to ⌊bodyHeight/3⌋ rows at `scroll`, which is clamped.
 */
export function agentList(agents: readonly AgentInfo[], o: { bodyHeight: number; scroll: number; open: ReadonlySet<string>; viewpoint: string }): AgentList {
  const agentRow = (a: AgentInfo, indent: 0 | 1, name: string): AgentListRow => ({
    kind: 'agent',
    key: a.key,
    badge: typeBadge(a.type),
    name,
    custom: a.key !== MAIN && typeBadge(a.type) === 'C',
    status: a.status,
    files: a.files.length,
    estTokens: a.estTokens,
    description: a.description,
    indent,
    selected: a.key === o.viewpoint,
  })
  const all: AgentListRow[] = []
  const main = agents.find((a) => a.key === MAIN)
  if (main) all.push(agentRow(main, 0, 'main'))
  const subs = agents.filter((a) => a.key !== MAIN)
  for (const a of subs.filter((x) => x.status !== 'done')) all.push(agentRow(a, 0, shortName(a, agents)))
  const done = subs.filter((a) => a.status === 'done').sort((a, b) => (b.end ?? 0) - (a.end ?? 0))
  const seen = new Set<string>()
  for (const a of done) {
    if (seen.has(a.type)) continue
    seen.add(a.type)
    const same = done.filter((x) => x.type === a.type)
    if (same.length === 1) {
      all.push(agentRow(a, 0, shortName(a, agents)))
      continue
    }
    const open = o.open.has(a.type)
    all.push({
      kind: 'group',
      type: a.type,
      badge: typeBadge(a.type),
      name: a.type,
      custom: typeBadge(a.type) === 'C',
      count: same.length,
      status: 'done',
      files: new Set(same.flatMap((x) => x.files)).size,
      estTokens: same.reduce((n, x) => n + x.estTokens, 0),
      open,
      selected: same.some((x) => x.key === o.viewpoint),
    })
    if (open) for (const x of same) all.push(agentRow(x, 1, x.label))
  }
  const cap = Math.max(0, Math.floor(o.bodyHeight / 3))
  const offset = Math.max(0, Math.min(Math.floor(o.scroll), all.length - cap))
  return { rows: all.slice(offset, offset + cap), offset, cap, total: all.length, above: offset > 0, below: offset + cap < all.length }
}

/** One expanded-list row as text, exactly `width` cells: `E Explore ×6 ✓ 14 files ≈22k · <task>`. */
export function agentListRowSegments(row: AgentListRow, width: number, cols: { readonly name: number } = { name: 0 }): AgentSeg[] {
  const key = row.kind === 'agent' ? { key: row.key } : {}
  const sel = row.selected ? { selected: true } : {}
  const segs: AgentSeg[] = []
  const indent = row.kind === 'agent' && row.indent === 1 ? 2 : 0
  if (indent) segs.push({ text: '  ', role: 'gap' })
  segs.push({ text: row.badge, role: 'badge', ...key, ...sel }, { text: ' ', role: 'gap' }, { text: row.name, role: 'name', ...key, ...sel })
  let nameW = indent + cellWidth(row.name)
  if (row.kind === 'group') {
    segs.push({ text: ` ×${row.count}`, role: 'count' })
    nameW += cellWidth(` ×${row.count}`)
  }
  if (row.custom) {
    segs.push({ text: ' (custom)', role: 'custom' })
    nameW += 9
  }
  // Columns line up down the list: name, status, files, ≈ tokens, then the task.
  segs.push({ text: ' '.repeat(Math.max(1, cols.name - nameW + 1)), role: 'gap' })
  segs.push({ text: row.status ? statusGlyph(row.status) : ' ', role: row.status ?? 'gap' })
  const files = `${row.files} ${row.files === 1 ? 'file' : 'files'}`
  segs.push({ text: files.padStart(10), role: 'files' })
  segs.push({ text: est(row.estTokens).padStart(8), role: 'tokens' })
  if (row.kind === 'agent' && row.description) segs.push({ text: '  ', role: 'gap' }, { text: row.description, role: 'description' })
  return fit(segs, width)
}

/** The name column's width for a list: the widest name (with `×N`, `(custom)` and indent). */
export function agentListNameWidth(rows: readonly AgentListRow[]): number {
  return Math.max(0, ...rows.map((r) => (r.kind === 'agent' && r.indent === 1 ? 2 : 0) + cellWidth(r.name) + (r.kind === 'group' ? cellWidth(` ×${r.count}`) : 0) + (r.custom ? 9 : 0)))
}
