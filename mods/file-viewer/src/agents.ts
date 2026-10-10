// One agent's view of the session, the agent order the switcher and the all-agents
// columns use, and the per-agent table of ≈ tokens and exact usage. Pure: derived from the state
// the reducer keeps (`FileState.byAgent`, `SessionState.registry`, `usageByAgent`).
import { isFull } from './intervals.ts'
import type { AgentTrack, CoverageState, FileState, SessionState, UsageTotals } from './model.ts'
import { MAIN_AGENT } from './reducer.ts'

/** The main conversation's key in `byAgent`, `usageByAgent` and the switcher. */
export const MAIN = MAIN_AGENT

/** The whole session, all agents together: what the lists show while no subagent exists. */
export const ALL = 'all'

/** Which attribution path the agent views rest on; confirmed live on Claude Code 2.1.295. */
export const ATTRIBUTION = 'tool.call agentId'

/** `main`, `Explore#1`, or `agent#a0ccdd` for an id the registry doesn't name. */
export function agentLabel(s: SessionState, key: string): string {
  if (key === MAIN || key === ALL) return key
  return s.registry.get(key)?.label ?? `agent#${key.slice(0, 6)}`
}

/** main, then the subagents in start order: the order `a` steps the viewpoint through. */
export function agentOrder(s: SessionState): string[] {
  return [MAIN, ...s.registry.keys()]
}

export function trackCoverage(tr: AgentTrack, totalLines: number | null): CoverageState {
  const full = totalLines !== null ? isFull(tr.intervals, totalLines) && (tr.intervals.length > 0 || tr.wholeRead || totalLines === 0) : tr.wholeRead
  if (full) return 'full'
  if (tr.unknownRead) return 'partial-unknown'
  if (tr.intervals.length > 0) return 'partial'
  if (tr.hits > 0) return 'hit'
  return 'none'
}

/**
 * The file as one agent saw it: its ranges, reads and ≈ tokens, its own history. Instruction and context facts
 * stay only when the agent itself loaded or read the file; another agent's share shows as `via`.
 */
export function projectFile(f: FileState, key: string, label: (key: string) => string): FileState {
  const tr = f.byAgent.get(key)
  const via = [...f.byAgent.keys()].filter((k) => k !== key).map(label)
  const history = f.history.filter((e) => (e.agentId ?? MAIN) === key)
  if (!tr) {
    return {
      ...f,
      intervals: [],
      authored: [],
      coverage: 'none',
      estTokens: 0,
      writtenTokens: 0,
      reads: 0,
      rereads: 0,
      stubs: 0,
      hits: 0,
      listings: 0,
      edits: 0,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      unknownRead: false,
      wholeRead: false,
      lastAction: null,
      lastTs: 0,
      instruction: null,
      inContext: false,
      contextTokens: 0,
      outOfContext: null,
      reloads: 0,
      lastReload: null,
      history,
      via,
    }
  }
  const main = key === MAIN
  return {
    ...f,
    intervals: tr.intervals,
    authored: main ? f.authored : [],
    coverage: f.instruction?.capped && main && f.coverage === 'capped' ? 'capped' : trackCoverage(tr, f.totalLines),
    estTokens: tr.estTokens,
    reads: tr.reads,
    rereads: tr.rereads,
    hits: tr.hits,
    listings: tr.listings,
    edits: tr.edits,
    writes: tr.writes,
    unknownRead: tr.unknownRead,
    wholeRead: tr.wholeRead,
    lastAction: tr.lastAction,
    lastTs: tr.lastTs,
    // The main context's facts belong to main; a subagent has its own context, never compacted here.
    ...(main ? {} : { inContext: false, contextTokens: 0, outOfContext: null, reloads: 0, lastReload: null }),
    history,
    via,
  }
}

/** The session as one agent saw it (the switcher's `main` or a subagent): every file projected; usage unchanged. */
export function agentState(s: SessionState, key: string): SessionState {
  const label = (k: string) => agentLabel(s, k)
  const files = new Map<string, FileState>()
  for (const [p, f] of s.files) files.set(p, projectFile(f, key, label))
  return { ...s, files }
}

export type AgentRow = {
  readonly key: string
  readonly label: string
  /** Files this agent read, searched, edited or loaded. */
  readonly files: number
  /** ≈ tokens (chars ÷ 4) of what it read and loaded. */
  readonly estTokens: number
  /** Exact API usage of its requests. */
  readonly usage: UsageTotals
  /** input + cache read + cache creation over its requests (cache re-reads counted each time), exact. */
  readonly billed: number
  readonly status: 'running' | 'done' | null
  readonly start: number | null
  readonly end: number | null
}

export type AgentTable = {
  readonly rows: AgentRow[]
  /** Claude Code's own forks (no SubagentStart): their loads and usage, apart from the agents; null when none. */
  readonly other: AgentRow | null
  /** Every row and `other` added up: equals the session's ≈ loaded and exact totals. */
  readonly total: { estTokens: number; billed: number; output: number; requests: number }
}

const NO_USAGE: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
const billedOf = (u: UsageTotals) => u.input + u.cacheRead + u.cacheCreation

/** Per-agent ≈ tokens and exact usage, rows that add up to the session totals. */
export function agentTable(s: SessionState): AgentTable {
  const rows: AgentRow[] = agentOrder(s).map((key) => {
    let files = 0
    let estTokens = 0
    for (const f of s.files.values()) {
      const tr = f.byAgent.get(key)
      if (!tr) continue
      files += 1
      estTokens += tr.estTokens
    }
    const usage = s.usageByAgent.get(key) ?? NO_USAGE
    const a = s.registry.get(key)
    return { key, label: agentLabel(s, key), files, estTokens, usage, billed: billedOf(usage), status: a?.status ?? null, start: a?.start ?? null, end: a?.end ?? null }
  })
  const known = new Set(agentOrder(s))
  const otherUsage: UsageTotals = { ...NO_USAGE }
  for (const [key, u] of s.usageByAgent) {
    if (known.has(key)) continue
    otherUsage.requests += u.requests
    otherUsage.input += u.input
    otherUsage.output += u.output
    otherUsage.cacheRead += u.cacheRead
    otherUsage.cacheCreation += u.cacheCreation
  }
  const other: AgentRow | null =
    otherUsage.requests > 0 || s.otherAgents.estTokens > 0
      ? { key: 'other', label: 'other', files: 0, estTokens: s.otherAgents.estTokens, usage: otherUsage, billed: billedOf(otherUsage), status: null, start: null, end: null }
      : null
  const all = other ? [...rows, other] : rows
  return {
    rows,
    other,
    total: {
      estTokens: all.reduce((n, r) => n + r.estTokens, 0),
      billed: all.reduce((n, r) => n + r.billed, 0),
      output: all.reduce((n, r) => n + r.usage.output, 0),
      requests: all.reduce((n, r) => n + r.usage.requests, 0),
    },
  }
}

/**
 * The footer's acting-agent note: `Explore#1 reading big.md` while a subagent's call is in flight
 * (newest first); null when only main works or no subagent exists.
 */
export function actingNote(s: SessionState, pending: Iterable<{ path: string; kind: string; agentId: string | null }>, name: (path: string) => string): string | null {
  if (s.registry.size === 0) return null
  let last: { path: string; kind: string; agentId: string | null } | null = null
  for (const p of pending) last = p
  if (!last) return null
  const verb = last.kind === 'edit' || last.kind === 'write' ? 'editing' : last.kind === 'commit' ? 'committing' : 'reading'
  return `${agentLabel(s, last.agentId ?? MAIN)} ${verb} ${name(last.path)}`
}
