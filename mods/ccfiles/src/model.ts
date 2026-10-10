// Data model. Events are append-only facts; FileState and Session
// are derived from them by the reducer, so a persisted log replays to the
// same view.
import type { Hunk, Range } from './intervals.ts'

export type EventKind =
  | 'read'
  | 'hit'
  | 'listing'
  | 'edit'
  | 'write'
  | 'commit'
  | 'autoload'
  | 'skillLoad'
  /** Session marker: a compaction happened; later loads count again. Path is ''. */
  | 'compact'

export type Outcome = 'ok' | 'denied' | 'error'

export type EventSource =
  | 'tool'
  | 'instructionsLoaded'
  | 'promptContext'
  | 'attachment'
  | 'skillPrompt'
  /** A read Claude Code re-injected after /compact (`file` attachment). */
  | 'compactRestore'
  /** Found by the read-only git scan after a Bash call (writes, commits). */
  | 'gitScan'
  | 'session'

/** Tier of an instruction file, or what kind of always-on text it is. */
export type InstructionOrigin = 'managed' | 'user' | 'project' | 'local' | 'memory' | 'skill' | 'plugin' | 'skillDescription'

export type Owner = { readonly kind: 'skill' | 'plugin'; readonly name: string }

export type FvEvent = {
  readonly ts: number
  readonly kind: EventKind
  /** `Read`, `Bash:sed`, `n/a` for loads Claude Code made on its own. */
  readonly tool: string
  /** Absolute path, or a virtual `skill-description:<name>` key. */
  readonly path: string
  readonly ranges: readonly Range[]
  readonly linesAdded: number
  readonly linesRemoved: number
  /** chars ÷ 4 of what Claude received; null when the content wasn't seen. */
  readonly estTokens: number | null
  /** chars ÷ 4 of what Claude wrote (Edit/Write payloads). Never part of cost. */
  readonly writtenTokens: number
  readonly outcome: Outcome
  /** null = the main conversation. */
  readonly agentId: string | null
  readonly agentType: string | null
  readonly source: EventSource
  /** false when the detection relied on a path not yet confirmed live. */
  readonly verified: boolean

  readonly toolUseId?: string
  /** Normalized file length learned from this event. */
  readonly totalLines?: number | null
  /** The read happened but which lines is unknown (partial-unknown). */
  readonly unknownRange?: boolean
  /** The read/load/write covers the whole file whatever its length. */
  readonly whole?: boolean
  /** Claude Code returned a PARTIAL view (token cap). */
  readonly truncated?: boolean
  /** A Read answered with Claude Code's `file_unchanged` stub ("already in your context"): tokens, no content. */
  readonly stub?: boolean
  readonly hunks?: readonly Hunk[]
  // Instruction files only:
  readonly loadReason?: string
  readonly memoryType?: string
  readonly triggerPath?: string
  readonly parentPath?: string
  readonly globs?: readonly string[]
  readonly origin?: InstructionOrigin
  /** Loaded content was cut by Claude Code (MEMORY.md 200 lines / 25 KB). */
  readonly capped?: boolean
  /** Lines Claude received when Claude Code stripped front matter; `totalLines` is the raw file. */
  readonly strippedLines?: number
  readonly owner?: Owner
  /** Detection relied on a fallback path (MEMORY.md, AGENTS.md, skill folder scan). */
  readonly viaFallback?: boolean
  /** Why, for the detail view: `detected via fallback: <note>`. */
  readonly fallbackNote?: string
  /** A skill-description row's SKILL.md path (U-6 folder scan). */
  readonly resolvedPath?: string
  /** The commit a `commit` event belongs to. */
  readonly sha?: string
}

/** Builds an event with every required field present (agent fields null for main). */
export function makeEvent(e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path' | 'source'>): FvEvent {
  return {
    ts: 0,
    tool: 'n/a',
    ranges: [],
    linesAdded: 0,
    linesRemoved: 0,
    estTokens: 0,
    writtenTokens: 0,
    outcome: 'ok',
    verified: true,
    ...e,
    agentId: e.agentId ?? null,
    agentType: e.agentType ?? null,
  }
}

export type Usage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
}

/** One line of the persisted log. */
export type LogRecord =
  | { readonly t: 'event'; readonly e: FvEvent }
  /** One API request's usage (turn.step). `tools`: how many tool calls it asked for (absent in older logs). */
  | { readonly t: 'usage'; readonly ts: number; readonly agentId: string | null; readonly model: string; readonly usage: Usage; readonly tools?: number }
  /**
   * An API request started (turn.step entry). The tool events a request causes are logged after its marker and
   * before the agent's next one, which lets calibration attribute them to the request's usage.
   */
  | { readonly t: 'step'; readonly ts: number; readonly agentId: string | null }
  /**
   * A subagent's type (user-visible), or one of Claude Code's internal forks (`internal`: empty agent_type;
   * `hint`: the start of its last message, to tell a compaction summary from a post-turn fork).
   */
  | {
      readonly t: 'agent'
      readonly ts: number
      readonly agentId: string
      readonly agentType: string
      readonly internal?: boolean
      readonly hint?: string | null
      /** The loop that spawned it (`agent.spawn` `parentAgentId`); null = main. */
      readonly parentId?: string | null
      /** The Agent call's few-word task, from `agent.spawn`. */
      readonly description?: string
      /** SubagentStop: the agent finished. */
      readonly stop?: true
    }
  /** Injected text not tied to a file (`prompt.attachment` types we don't map), for "other ≈ tok". */
  | { readonly t: 'injected'; readonly ts: number; readonly type: string; readonly estTokens: number; readonly agentId: string | null }
  /** An agent's Bash shell moved (a `cd` persists between calls); null = unknown. */
  | { readonly t: 'shell'; readonly ts: number; readonly agentId: string | null; readonly cwd: string | null }

export type CoverageState = 'none' | 'full' | 'partial' | 'partial-unknown' | 'hit' | 'capped'

export type InstructionInfo = {
  origin: InstructionOrigin
  /** auto = loaded by Claude Code, tool = Claude read it, both. */
  mode: 'auto' | 'tool' | 'both'
  loads: number
  loadReasons: string[]
  triggerPath: string | null
  parentPath: string | null
  globs: readonly string[]
  memoryType: string | null
  capped: boolean
  /** Lines Claude received of a front-matter-stripped load; null when it got the whole raw text. */
  strippedLines: number | null
  verified: boolean
  /** Where a skill-description row's SKILL.md lives, when a folder scan found it. */
  resolvedPath: string | null
}

export type FileState = {
  path: string
  /** Lines Claude has seen: read or loaded, plus lines it wrote (`authored`). */
  intervals: Range[]
  /** Lines known only because Claude wrote them (Edit/Write); no read cost. A later read moves them out. */
  authored: Range[]
  totalLines: number | null
  coverage: CoverageState
  /** Reads + auto-loads only. */
  estTokens: number
  /** Edit/Write payloads, shown apart from cost. */
  writtenTokens: number
  reads: number
  rereads: number
  /** `file_unchanged` dedup stubs: counted in ≈tokens, not reads. */
  stubs: number
  hits: number
  listings: number
  edits: number
  writes: number
  linesAdded: number
  linesRemoved: number
  denied: number
  errors: number
  unknownRead: boolean
  wholeRead: boolean
  lastAction: EventKind | null
  lastOutcome: Outcome | null
  lastTs: number
  gitStatus: string | null
  instruction: InstructionInfo | null
  owner: Owner | null
  /** Subagent ids that touched the file (for the per-agent views). */
  agents: string[]
  /** What each agent ('main' or its id) saw of the file, kept apart. Sums to the file's figures. */
  byAgent: Map<string, AgentTrack>
  /** Only in one agent's view (`agentState`): the other agents that saw the file, by label (`via Explore#1`). */
  via?: readonly string[]
  /** false while any detection behind the row is unverified (renders `?`). */
  verified: boolean
  /** The fallback a detection behind the row relied on, or null. */
  viaFallback: string | null
  /** In the main conversation's context now: loaded, read or re-injected since the last compaction. */
  inContext: boolean
  /** ≈ tokens of this file in the main context now (loads and reads since the last compaction). */
  contextTokens: number
  /** A compaction dropped it and nothing re-injected or re-read it since: "out of context since compaction". */
  outOfContext: { epoch: number; ts: number } | null
  /** Compactions that reloaded the file (instruction reload or re-injected read). */
  reloads: number
  lastReload: { epoch: number; ts: number } | null
  history: FvEvent[]
}

/** One agent's share of a file: its own ranges, reads and ≈ tokens. */
export type AgentTrack = {
  intervals: Range[]
  unknownRead: boolean
  wholeRead: boolean
  estTokens: number
  reads: number
  rereads: number
  hits: number
  listings: number
  edits: number
  writes: number
  /** Loads Claude Code made into this agent's context (instructions, skills). */
  loads: number
  lastAction: EventKind | null
  lastTs: number
}

/** A user-visible subagent. Claude Code's own forks (empty agent_type) are never entries. */
export type AgentEntry = {
  readonly id: string
  type: string
  /** `Explore#1`: the type and its place among agents of that type, by start. */
  label: string
  parentId: string | null
  description: string | null
  start: number
  end: number | null
  status: 'running' | 'done'
}

export type UsageTotals = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type SessionState = {
  files: Map<string, FileState>
  /** Exact API usage from turn.step, all agents, and per agent ('main' for null). */
  usage: UsageTotals
  usageByAgent: Map<string, UsageTotals>
  /** Context size of the latest main-loop request (input + cache read + cache creation). */
  latestContext: number | null
  /** The latest request's context size per agent ('main' for null): a subagent viewpoint's footer figure. */
  contextByAgent: Map<string, number>
  /** input + cache read + cache creation summed over every request (cache re-reads count each time). */
  billedSum: number
  agents: Map<string, string>
  /** User-visible subagents in start order. */
  registry: Map<string, AgentEntry>
  /** Claude Code's own forks (compaction, post-turn helpers): id → hint. Not user-visible subagents. */
  internalAgents: Map<string, string | null>
  /** What agents with no known type loaded (kept in history, left out of the file totals). */
  otherAgents: { agents: Set<string>; estTokens: number }
  /** Compactions seen so far. */
  epoch: number
  injected: Map<string, { count: number; estTokens: number }>
  /** Each agent's Bash directory ('main' for null) once a cd moved it; null = unknown. */
  shellCwd: Map<string, string | null>
  events: FvEvent[]
}
