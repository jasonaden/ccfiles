// (state, record) → state. Deterministic and I/O-free, so the persisted log
// replays to exactly the live view.
import { addRange, applyPatch, isFull, normalize, subtract, type Range } from './intervals.ts'
import { classifyPath } from './instructions.ts'
import { makeEvent, type AgentTrack, type FileState, type FvEvent, type InstructionInfo, type InstructionOrigin, type LogRecord, type SessionState, type UsageTotals } from './model.ts'
import { dirname } from './paths.ts'

/** `awaiting`: the epoch|agent key of an InstructionsLoaded still waiting for its content. */
type LoadTrack = { awaiting: string | null; keys: Set<string> }

// Bookkeeping that isn't part of the view: kept beside each state object.
const tracks = new WeakMap<SessionState, { loads: Map<string, LoadTrack>; restores: Set<string>; skillDirs: Map<string, string> }>()

export function emptyState(): SessionState {
  const s: SessionState = {
    files: new Map(),
    usage: emptyUsage(),
    usageByAgent: new Map(),
    latestContext: null,
    contextByAgent: new Map(),
    billedSum: 0,
    agents: new Map(),
    registry: new Map(),
    internalAgents: new Map(),
    otherAgents: { agents: new Set(), estTokens: 0 },
    epoch: 0,
    injected: new Map(),
    shellCwd: new Map(),
    events: [],
  }
  tracks.set(s, { loads: new Map(), restores: new Set(), skillDirs: new Map() })
  return s
}

export function replay(records: readonly LogRecord[]): SessionState {
  const s = emptyState()
  for (const r of records) apply(s, r)
  return s
}

export function apply(s: SessionState, r: LogRecord): void {
  switch (r.t) {
    case 'event':
      applyEvent(s, r.e)
      return
    case 'usage': {
      const key = r.agentId ?? 'main'
      const per = s.usageByAgent.get(key) ?? emptyUsage()
      for (const u of [s.usage, per]) {
        u.requests += 1
        u.input += r.usage.input_tokens
        u.output += r.usage.output_tokens
        u.cacheRead += r.usage.cache_read_input_tokens
        u.cacheCreation += r.usage.cache_creation_input_tokens
      }
      s.usageByAgent.set(key, per)
      const context = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      s.billedSum += context
      if (r.agentId === null) s.latestContext = context
      s.contextByAgent.set(key, context)
      return
    }
    case 'agent':
      if (r.internal) s.internalAgents.set(r.agentId, r.hint ?? s.internalAgents.get(r.agentId) ?? null)
      else if (r.agentType) register(s, r)
      return
    case 'shell':
      s.shellCwd.set(r.agentId ?? 'main', r.cwd)
      return
    case 'injected': {
      const cur = s.injected.get(r.type) ?? { count: 0, estTokens: 0 }
      s.injected.set(r.type, { count: cur.count + 1, estTokens: cur.estTokens + r.estTokens })
      return
    }
  }
}

function applyEvent(s: SessionState, e: FvEvent): void {
  s.events.push(e)
  if (e.kind === 'compact') {
    s.epoch += 1
    // The main context was summarized: nothing is in it until re-injected or read again,
    // except the skill descriptions: the listing Claude Code re-sends is one fresh load in the new epoch.
    for (const f of s.files.values()) {
      if (!f.inContext) continue
      if (f.instruction?.origin === 'skillDescription') {
        carryDescription(s, f, e.ts)
        continue
      }
      f.inContext = false
      f.contextTokens = 0
      f.outOfContext = { epoch: s.epoch, ts: e.ts }
    }
    return
  }
  if (isOtherAgent(s, e)) {
    // A user-visible subagent announces its type (SubagentStart) before its first request; an agent
    // without one is Claude Code's own fork. Keep the fact, leave it out of the file totals.
    fileFor(s, e.path).history.push(e)
    s.otherAgents.agents.add(e.agentId!)
    if (e.outcome === 'ok') s.otherAgents.estTokens += e.estTokens ?? 0
    return
  }
  const t = tracks.get(s)!
  if ((e.kind === 'read' || e.kind === 'skillLoad') && e.source === 'compactRestore') {
    // One compaction may re-inject a read or a skill more than once (a resume re-sends it): once per path, epoch and agent.
    const key = `${e.path}|${s.epoch}|${e.agentId ?? 'main'}`
    if (t.restores.has(key)) return
    t.restores.add(key)
  }
  const f = fileFor(s, e.path)
  f.history.push(e)
  if (e.agentId !== null && !f.agents.includes(e.agentId)) f.agents.push(e.agentId)
  if (e.outcome === 'ok') {
    const before = counts(f)
    applyOk(s, t, f, e)
    trackAgent(f, e, before)
    return
  }
  applyOk(s, t, f, e)
}

/** The file's figures an agent's track takes its share of: what one event adds goes to the event's agent. */
function counts(f: FileState) {
  return { estTokens: f.estTokens, reads: f.reads, hits: f.hits, listings: f.listings, edits: f.edits, writes: f.writes, loads: f.instruction?.loads ?? 0 }
}

function applyOk(s: SessionState, t: NonNullable<ReturnType<typeof tracks.get>>, f: FileState, e: FvEvent): void {
  if (e.outcome !== 'ok') {
    if (e.outcome === 'denied') f.denied += 1
    else f.errors += 1
    f.lastOutcome = e.outcome
    return
  }
  if (!e.verified) f.verified = false
  if (e.viaFallback) f.viaFallback = e.fallbackNote ?? 'fallback'
  f.lastOutcome = 'ok'
  f.lastAction = e.kind
  f.lastTs = e.ts
  if (e.totalLines !== undefined && e.totalLines !== null) setTotal(f, e.totalLines)
  if (e.owner) f.owner = e.owner
  else if (!f.owner) f.owner = ownerFromSkillDirs(e.path, t.skillDirs) ?? classifyPath(e.path)?.owner ?? null

  switch (e.kind) {
    case 'read':
      applyRead(f, e)
      if (e.source === 'compactRestore') markReloaded(f, s.epoch, e.ts)
      break
    case 'hit':
      f.hits += 1
      break
    case 'listing':
      f.listings += 1
      break
    case 'edit':
      f.edits += 1
      f.linesAdded += e.linesAdded
      f.linesRemoved += e.linesRemoved
      f.writtenTokens += e.writtenTokens
      if (e.hunks && e.hunks.length > 0) {
        // Edit results carry no content: coverage moves through the patch, and the written lines are authored.
        const seen = applyPatch(f.intervals, e.hunks)
        f.authored = normalize([...applyPatch(f.authored, e.hunks).kept, ...seen.added])
        f.intervals = normalize([...seen.kept, ...seen.added])
        if (f.totalLines !== null) f.totalLines += e.hunks.reduce((n, h) => n + h.newLines - h.oldLines, 0)
      } else if (f.totalLines !== null && e.totalLines == null) {
        f.totalLines += e.linesAdded - e.linesRemoved
      }
      break
    case 'write':
      f.writes += 1
      f.linesAdded += e.linesAdded
      f.linesRemoved += e.linesRemoved
      f.writtenTokens += e.writtenTokens
      // A file Bash wrote (found by the git scan) wasn't shown to Claude: no coverage.
      if (e.source === 'gitScan') break
      f.unknownRead = false
      f.wholeRead = true
      f.intervals = f.totalLines !== null && f.totalLines > 0 ? [[1, f.totalLines]] : []
      f.authored = [...f.intervals]
      break
    case 'skillLoad': {
      const name = e.owner?.name
      if (name && e.owner?.kind === 'skill') t.skillDirs.set(dirname(e.path), name)
      const info = instructionFor(f, e.origin ?? 'skill', 'auto')
      info.loads += 1
      info.loadReasons.push(e.loadReason ?? 'skill_invoked')
      if (!e.verified) info.verified = false
      f.estTokens += e.estTokens ?? 0
      enterContext(f, e, e.estTokens ?? 0)
      if (e.source === 'compactRestore') markReloaded(f, s.epoch, e.ts)
      cover(f, e)
      break
    }
    case 'autoload':
      applyAutoload(s, t.loads, f, e)
      break
    case 'commit':
      break
  }
  recompute(f)
}

export const MAIN_AGENT = 'main'

function trackFor(f: FileState, key: string): AgentTrack {
  let tr = f.byAgent.get(key)
  if (!tr) {
    tr = { intervals: [], unknownRead: false, wholeRead: false, estTokens: 0, reads: 0, rereads: 0, hits: 0, listings: 0, edits: 0, writes: 0, loads: 0, lastAction: null, lastTs: 0 }
    f.byAgent.set(key, tr)
  }
  return tr
}

/**
 * The event's agent gets what the event added to the file (so the tracks sum to the file's figures) and the lines
 * it saw; an edit moves every agent's lines with the content. Re-reads are an agent's own (another agent's read of
 * the same lines is not one).
 */
function trackAgent(f: FileState, e: FvEvent, before: ReturnType<typeof counts>): void {
  if (e.kind === 'compact') return
  const now = counts(f)
  const key = e.agentId ?? MAIN_AGENT
  const had = f.byAgent.has(key)
  if (e.kind === 'edit' && e.hunks && e.hunks.length > 0) {
    for (const [k, other] of f.byAgent) if (k !== key) other.intervals = applyPatch(other.intervals, e.hunks).kept
  }
  const tr = trackFor(f, key)
  tr.estTokens += now.estTokens - before.estTokens
  tr.reads += now.reads - before.reads
  tr.hits += now.hits - before.hits
  tr.listings += now.listings - before.listings
  tr.edits += now.edits - before.edits
  tr.writes += now.writes - before.writes
  tr.loads += now.loads - before.loads
  tr.lastAction = e.kind
  tr.lastTs = e.ts
  switch (e.kind) {
    case 'read':
      if (e.stub) break
      if (now.reads > before.reads) {
        const seen = tr.intervals.length > 0 || tr.wholeRead
        if (e.ranges.some((r) => intersects(tr.intervals, r)) || (e.whole === true && seen)) tr.rereads += 1
      }
      if (e.unknownRange) tr.unknownRead = true
      coverTrack(f, tr, e)
      break
    case 'autoload':
    case 'skillLoad':
      coverTrack(f, tr, e)
      break
    case 'edit':
      if (e.hunks && e.hunks.length > 0) {
        const seen = applyPatch(tr.intervals, e.hunks)
        tr.intervals = normalize([...seen.kept, ...seen.added])
      }
      break
    case 'write':
      if (e.source === 'gitScan') break
      tr.wholeRead = true
      tr.unknownRead = false
      tr.intervals = f.totalLines !== null && f.totalLines > 0 ? [[1, f.totalLines]] : []
      break
  }
  // A repeat signal that added nothing to an agent with no track yet leaves no empty track behind.
  if (!had && tr.lastAction !== null && isEmptyTrack(tr) && e.kind !== 'hit' && e.kind !== 'listing' && e.kind !== 'commit') f.byAgent.delete(key)
}

function isEmptyTrack(tr: AgentTrack): boolean {
  return tr.estTokens === 0 && tr.reads + tr.hits + tr.listings + tr.edits + tr.writes + tr.loads === 0 && tr.intervals.length === 0 && !tr.wholeRead && !tr.unknownRead
}

function coverTrack(f: FileState, tr: AgentTrack, e: FvEvent): void {
  if (e.ranges.length > 0) tr.intervals = normalize(e.ranges.reduce<Range[]>((set, r) => addRange(set, r), tr.intervals))
  if (e.whole) {
    tr.wholeRead = true
    if (f.totalLines !== null && f.totalLines > 0) tr.intervals = addRange(tr.intervals, [1, f.totalLines])
  }
}

/** A subagent's start, spawn details and stop, in whatever order they arrive. */
function register(s: SessionState, r: Extract<LogRecord, { t: 'agent' }>): void {
  s.agents.set(r.agentId, r.agentType)
  let a = s.registry.get(r.agentId)
  if (!a) {
    const n = [...s.registry.values()].filter((x) => x.type === r.agentType).length + 1
    a = { id: r.agentId, type: r.agentType, label: `${r.agentType}#${n}`, parentId: null, description: null, start: r.ts, end: null, status: 'running' }
    s.registry.set(r.agentId, a)
  }
  if (r.parentId !== undefined) a.parentId = r.parentId
  if (r.description !== undefined) a.description = r.description
  if (r.stop) {
    a.end = r.ts
    a.status = 'done'
  }
}

function applyRead(f: FileState, e: FvEvent): void {
  if (e.stub) {
    // Claude got a pointer to content it already holds: the stub's tokens, no new lines.
    f.stubs += 1
    f.estTokens += e.estTokens ?? 0
    enterContext(f, e, e.estTokens ?? 0)
    return
  }
  const cls = classifyPath(e.path)
  if (f.instruction) {
    if (f.instruction.mode === 'auto') f.instruction.mode = 'both'
  } else if (cls || f.owner) {
    instructionFor(f, cls?.origin ?? (f.owner?.kind === 'plugin' ? 'plugin' : 'skill'), 'tool')
  }
  const seenBefore = f.intervals.length > 0 || f.wholeRead
  const overlaps = e.ranges.some((r) => intersects(f.intervals, r)) || (e.whole === true && seenBefore)
  if (overlaps || (f.coverage === 'full' && e.ranges.length > 0)) f.rereads += 1
  f.reads += 1
  f.estTokens += e.estTokens ?? 0
  enterContext(f, e, e.estTokens ?? 0)
  if (e.unknownRange) f.unknownRead = true
  cover(f, e)
}

/** The main conversation now holds (more of) the file. Subagents have their own contexts. */
function enterContext(f: FileState, e: FvEvent, tokens: number): void {
  if (e.agentId !== null) return
  f.inContext = true
  f.outOfContext = null
  f.contextTokens += tokens
}

function applyAutoload(s: SessionState, loads: Map<string, LoadTrack>, f: FileState, e: FvEvent): void {
  const info = instructionFor(f, e.origin ?? f.instruction?.origin ?? originFromMemoryType(e.memoryType), 'auto')
  if (info.mode === 'tool') info.mode = 'both'
  if (e.origin) info.origin = e.origin
  if (e.memoryType) info.memoryType = e.memoryType
  if (e.triggerPath) info.triggerPath = e.triggerPath
  if (e.parentPath) info.parentPath = e.parentPath
  if (e.globs) info.globs = e.globs
  if (e.capped !== undefined) info.capped = e.capped
  if (e.strippedLines !== undefined) info.strippedLines = e.strippedLines
  if (e.resolvedPath) info.resolvedPath = e.resolvedPath
  if (!e.verified) info.verified = false

  const track = loads.get(f.path) ?? { awaiting: null, keys: new Set<string>() }
  loads.set(f.path, track)
  const key = `${s.epoch}|${e.agentId ?? 'main'}`
  const reason = e.loadReason ?? 'session_start'
  const agent = e.agentId ?? 'main'
  const counted = () => {
    // The same agent loaded it before an earlier compaction: a reload.
    if ([...track.keys].some((k) => k.endsWith(`|${agent}`) && Number(k.slice(0, k.indexOf('|'))) < s.epoch)) markReloaded(f, s.epoch, e.ts)
    info.loads += 1
    info.loadReasons.push(reason)
    enterContext(f, e, 0)
  }

  if (e.source === 'instructionsLoaded') {
    // One load per file per agent per compaction epoch: a repeat (a resumed
    // process announcing the same files) adds nothing.
    if (track.keys.has(key)) return
    track.keys.add(key)
    track.awaiting = key
    counted()
    return
  }
  if (track.awaiting === key) {
    track.awaiting = null
  } else {
    if (track.keys.has(key)) {
      // A repeat signal adds no tokens, but what it showed was seen (a whole restore stays 100%).
      cover(f, e)
      return
    }
    track.keys.add(key)
    track.awaiting = null
    counted()
  }
  f.estTokens += e.estTokens ?? 0
  enterContext(f, e, e.estTokens ?? 0)
  cover(f, e)
}

/**
 * A skill description through a compaction: one fresh load in the new epoch (same tokens, still one copy in
 * context). Its agent + path + epoch key is taken, so the listing re-sent in this epoch is a repeat.
 */
function carryDescription(s: SessionState, f: FileState, ts: number): void {
  const loads = tracks.get(s)!.loads
  const track = loads.get(f.path) ?? { awaiting: null, keys: new Set<string>() }
  loads.set(f.path, track)
  track.keys.add(`${s.epoch}|main`)
  const info = f.instruction!
  info.loads += 1
  info.loadReasons.push('compact')
  f.estTokens += f.contextTokens
  const tr = trackFor(f, MAIN_AGENT)
  tr.loads += 1
  tr.estTokens += f.contextTokens
  markReloaded(f, s.epoch, ts)
  f.history.push(
    makeEvent({ ts, kind: 'autoload', path: f.path, source: 'compactRestore', whole: true, estTokens: f.contextTokens, origin: 'skillDescription', loadReason: 'compact' }),
  )
}

function isOtherAgent(s: SessionState, e: FvEvent): boolean {
  return e.agentId !== null && !e.agentType && !s.agents.has(e.agentId)
}

function markReloaded(f: FileState, epoch: number, ts: number): void {
  if (f.lastReload?.epoch === epoch) return
  f.reloads += 1
  f.lastReload = { epoch, ts }
}

function cover(f: FileState, e: FvEvent): void {
  if (e.ranges.length > 0) {
    f.intervals = normalize(e.ranges.reduce<Range[]>((set, r) => addRange(set, r), f.intervals))
    f.authored = subtract(f.authored, e.ranges)
  }
  if (e.whole) {
    f.wholeRead = true
    if (f.totalLines !== null && f.totalLines > 0) f.intervals = addRange(f.intervals, [1, f.totalLines])
    f.authored = []
  }
}

function setTotal(f: FileState, total: number): void {
  f.totalLines = total
  if (f.wholeRead && total > 0 && f.intervals.length === 0) f.intervals = [[1, total]]
}

function recompute(f: FileState): void {
  const full = f.totalLines !== null ? isFull(f.intervals, f.totalLines) && (f.intervals.length > 0 || f.wholeRead || f.totalLines === 0) : f.wholeRead
  if (f.instruction?.capped && !full) f.coverage = 'capped'
  else if (full) f.coverage = 'full'
  else if (f.unknownRead) f.coverage = 'partial-unknown'
  else if (f.intervals.length > 0) f.coverage = 'partial'
  else if (f.hits > 0) f.coverage = 'hit'
  else f.coverage = 'none'
}

function intersects(set: readonly Range[], [a, b]: Range): boolean {
  return set.some(([x, y]) => a <= y && b >= x)
}

function instructionFor(f: FileState, origin: InstructionOrigin, mode: 'auto' | 'tool'): InstructionInfo {
  f.instruction ??= {
    origin,
    mode,
    loads: 0,
    loadReasons: [],
    triggerPath: null,
    parentPath: null,
    globs: [],
    memoryType: null,
    capped: false,
    strippedLines: null,
    verified: true,
    resolvedPath: null,
  }
  return f.instruction
}

function originFromMemoryType(t: string | undefined): InstructionOrigin {
  switch (t) {
    case 'User':
      return 'user'
    case 'Local':
      return 'local'
    case 'Managed':
      return 'managed'
    default:
      return 'project'
  }
}

function ownerFromSkillDirs(path: string, dirs: ReadonlyMap<string, string>) {
  for (const [dir, name] of dirs) if (path.startsWith(dir + '/')) return { kind: 'skill' as const, name }
  return null
}

function fileFor(s: SessionState, path: string): FileState {
  let f = s.files.get(path)
  if (!f) {
    f = {
      path,
      intervals: [],
      authored: [],
      totalLines: null,
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
      denied: 0,
      errors: 0,
      unknownRead: false,
      wholeRead: false,
      lastAction: null,
      lastOutcome: null,
      lastTs: 0,
      gitStatus: null,
      instruction: null,
      owner: null,
      agents: [],
      byAgent: new Map(),
      verified: true,
      viaFallback: null,
      inContext: false,
      contextTokens: 0,
      outOfContext: null,
      reloads: 0,
      lastReload: null,
      history: [],
    }
    s.files.set(path, f)
  }
  return f
}

function emptyUsage(): UsageTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}
