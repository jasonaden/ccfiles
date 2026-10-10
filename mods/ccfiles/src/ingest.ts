// Event payloads → log records. Pure: the hook gathers anything that needs
// I/O (file totals, the on-disk MEMORY.md) and passes it in.
import { UNRESOLVED, bashActions, matchPath } from './bash.ts'
import type { Hunk } from './intervals.ts'
import {
  classifyPath,
  lineCount,
  numberedRange,
  parseNestedMemory,
  parseRestoredRead,
  parseSkillListing,
  sharedLeadingLines,
  skillBaseDir,
  skillOwner,
} from './instructions.ts'
import { makeEvent, type EventKind, type FvEvent, type InstructionOrigin, type LogRecord, type Outcome } from './model.ts'
import { basename, resolvePath } from './paths.ts'
import { estTokens } from './tokens.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' ? (v as Rec) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** 2.1.295 reports a permission-settings denial as an errored result with this text, not as `deny`. */
const DENIED_TEXT = /denied by your permission settings|permission to .+ (?:was|has been) denied/i

export type Agent = { readonly agentId: string | null; readonly agentType: string | null }

// ---- tool.call ---------------------------------------------------------------

/** The file a tool call targets, before it runs (for the pending row). */
export function toolTarget(e: Rec): { path: string; kind: EventKind } | null {
  switch (e.tool) {
    case 'Read':
      return str(e.file_path) ? { path: str(e.file_path)!, kind: 'read' } : null
    case 'Edit':
      return str(e.file_path) ? { path: str(e.file_path)!, kind: 'edit' } : null
    case 'Write':
      return str(e.file_path) ? { path: str(e.file_path)!, kind: 'write' } : null
    case 'NotebookEdit':
      return str(e.notebook_path) ? { path: str(e.notebook_path)!, kind: 'edit' } : null
  }
  return null
}

/** The file a pending row shows while a call runs: the tool's target, or a Bash command's first read. */
export function pendingTarget(e: Rec, cwd: string | null): { path: string; kind: EventKind } | null {
  return toolTarget(e) ?? (cwd ? bashTarget(e, cwd) : null)
}

/** Whether a Read result reached the file's last line (so its content shows the final newline). */
export function readNeedsNewlineCheck(e: Rec, r: Rec): string | null {
  if (e.tool !== 'Read') return null
  const result = rec(r.result)
  const file = rec(result.file)
  if (result.type !== 'text') return null
  const start = num(file.startLine) ?? 1
  const n = num(file.numLines) ?? 0
  const total = num(file.totalLines)
  if (total === undefined || start + n - 1 >= total) return null
  return str(file.filePath) ?? str(e.file_path) ?? null
}

export type ToolContext = Agent & {
  readonly ts: number
  /** Where relative paths resolve: the agent's Bash directory, else the session's. */
  readonly cwd: string
  /** False after `cd -`: relative Bash paths are guesses. */
  readonly cwdKnown?: boolean
  readonly home?: string | null
  /** For a Read that didn't reach the end: does the file end with a newline? null = unknown. */
  readonly endsWithNewline: boolean | null
  /** Known normalized totals (from state or a file read). */
  readonly totals: (path: string) => number | null
}

/** Events for one settled tool call. Denied and errored calls yield a logged event with no effect. */
export function toolEvents(e: Rec, r: Rec, ctx: ToolContext): FvEvent[] {
  const tool = str(e.tool) ?? 'n/a'
  const base = { ts: ctx.ts, agentId: ctx.agentId, agentType: ctx.agentType, source: 'tool' as const, toolUseId: str(e.tool_use_id), tool }
  const outcome: Outcome = typeof r.deny === 'string' || (r.isError === true && DENIED_TEXT.test(str(r.text) ?? '')) ? 'denied' : r.isError === true ? 'error' : 'ok'
  if (outcome !== 'ok') {
    const target = toolTarget(e) ?? bashTarget(e, ctx.cwd)
    return target ? [makeEvent({ ...base, ...target, outcome, estTokens: 0 })] : []
  }
  const result = rec(r.result)
  const text = str(r.text) ?? ''
  switch (tool) {
    case 'Read':
      return [readEvent(e, result, text, base, ctx.endsWithNewline)]
    case 'Edit':
      return [editEvent(e, result, base)]
    case 'Write': {
      const content = str(e.content) ?? str(result.content) ?? ''
      const total = lineCount(content)
      const counts = hunkCounts(result.structuredPatch)
      const created = result.type === 'create' || result.originalFile === null
      return [
        makeEvent({
          ...base,
          kind: 'write',
          path: str(result.filePath) ?? str(e.file_path) ?? '',
          whole: true,
          totalLines: total,
          linesAdded: counts ? counts.added : created ? total : 0,
          linesRemoved: counts ? counts.removed : 0,
          estTokens: 0,
          writtenTokens: estTokens(content),
        }),
      ]
    }
    case 'NotebookEdit': {
      const src = str(e.new_source) ?? ''
      return [
        makeEvent({
          ...base,
          kind: 'edit',
          path: str(e.notebook_path) ?? str(result.notebook_path) ?? '',
          linesAdded: e.edit_mode === 'delete' ? 0 : lineCount(src),
          linesRemoved: lineCount(str(result.old_source) ?? ''),
          estTokens: 0,
          writtenTokens: estTokens(src),
        }),
      ]
    }
    case 'Grep':
      return searchPaths(e, result, text, ctx.cwd).map((path) => makeEvent({ ...base, kind: 'hit', path, estTokens: 0, verified: false }))
    case 'Glob':
      return (Array.isArray(result.filenames) ? result.filenames : text.split('\n'))
        .filter((p): p is string => typeof p === 'string' && p.trim() !== '' && !p.startsWith('No files found'))
        .slice(0, 200)
        .map((p) => makeEvent({ ...base, kind: 'listing', path: resolvePath(str(e.path) ?? ctx.cwd, p), estTokens: 0, verified: false }))
    case 'Bash':
      return bashEvents(e, result, text, base, ctx)
  }
  return []
}

type Base = Agent & { ts: number; source: 'tool'; toolUseId: string | undefined; tool: string }

function readEvent(e: Rec, result: Rec, text: string, base: Base, endsWithNewline: boolean | null): FvEvent {
  const file = rec(result.file)
  const path = str(file.filePath) ?? str(e.file_path) ?? ''
  const tokens = estTokens(text)
  if (result.type === 'file_unchanged') return makeEvent({ ...base, kind: 'read', path, estTokens: tokens, stub: true })
  if (result.type !== 'text') {
    // Image, PDF, notebook: whole unless a page range was asked for.
    const paged = typeof e.pages === 'string'
    return makeEvent({ ...base, kind: 'read', path, estTokens: tokens, whole: !paged, unknownRange: paged })
  }
  const start = num(file.startLine) ?? 1
  const n = num(file.numLines) ?? 0
  const reported = num(file.totalLines)
  const content = str(file.content) ?? ''
  // Read's totalLines counts the empty line after a final newline (1,323-line file → 1324).
  let trailingNewline: boolean | null
  let verified = true
  if (reported !== undefined && start + n - 1 >= reported) trailingNewline = content === '' || content.endsWith('\n')
  else {
    trailingNewline = endsWithNewline
    if (trailingNewline === null) {
      trailingNewline = true
      verified = false
    }
  }
  const total = reported === undefined ? null : Math.max(0, reported - (trailingNewline ? 1 : 0))
  const end = total === null ? start + n - 1 : Math.min(start + n - 1, total)
  return makeEvent({
    ...base,
    kind: 'read',
    path,
    ranges: end >= start ? [[start, end]] : [],
    totalLines: total,
    estTokens: tokens,
    truncated: file.truncatedByTokenCap === true ? true : undefined,
    verified,
  })
}

function editEvent(e: Rec, result: Rec, base: Base): FvEvent {
  const path = str(result.filePath) ?? str(e.file_path) ?? ''
  const newString = str(e.new_string) ?? str(result.newString) ?? ''
  const counts = hunkCounts(result.structuredPatch)
  if (counts) {
    return makeEvent({ ...base, kind: 'edit', path, hunks: counts.hunks, linesAdded: counts.added, linesRemoved: counts.removed, estTokens: 0, writtenTokens: estTokens(newString) })
  }
  // No patch: sizes from the strings, position unknown so nothing shifts.
  return makeEvent({
    ...base,
    kind: 'edit',
    path,
    linesAdded: lineCount(newString) || 1,
    linesRemoved: lineCount(str(e.old_string) ?? '') || 1,
    estTokens: 0,
    writtenTokens: estTokens(newString),
    verified: false,
  })
}

function hunkCounts(patch: unknown): { hunks: Hunk[]; added: number; removed: number } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null
  const hunks: Hunk[] = []
  let added = 0
  let removed = 0
  for (const raw of patch) {
    const h = rec(raw)
    const oldStart = num(h.oldStart)
    const oldLines = num(h.oldLines)
    const newStart = num(h.newStart)
    const newLines = num(h.newLines)
    if (oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined) return null
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : null
    hunks.push(lines ? { oldStart, oldLines, newStart, newLines, lines: lines.map((l) => l.slice(0, 1)) } : { oldStart, oldLines, newStart, newLines })
    for (const line of lines ?? []) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { hunks, added, removed }
}

/** The files a Grep result names: its file list, else the `path:line:` part of each content line. */
function searchPaths(e: Rec, result: Rec, text: string, cwd: string): string[] {
  const root = str(e.path) ?? cwd
  const names = Array.isArray(result.filenames) && result.mode !== 'content' ? result.filenames.filter((p): p is string => typeof p === 'string') : null
  const lines = (str(result.content) ?? text).split('\n').filter((l) => l.trim() !== '' && !l.startsWith('Found ') && !l.startsWith('No files found') && !l.startsWith('No matches found'))
  let raw: (string | null)[]
  if (names && names.length > 0) raw = names
  else if (result.mode === 'content') {
    // One file searched: its lines carry no file name (`164:text`), so the match is that file's.
    raw = lines.every((l) => /^\d+[:-]/.test(l) || l === '--') ? [str(e.path) ?? null] : lines.map((l) => matchPath(l))
  } else if (result.mode === 'count') raw = lines.map((l) => /^(.+):\d+$/.exec(l)?.[1] ?? null)
  else raw = lines.map((l) => l.trim())
  const paths = raw.filter((p): p is string => p !== null && p !== '' && p !== '--').map((p) => resolvePath(root, p))
  return [...new Set(paths)].slice(0, 200)
}

function bashTarget(e: Rec, cwd: string): { path: string; kind: EventKind } | null {
  if (e.tool !== 'Bash' || typeof e.command !== 'string') return null
  const first = bashActions(e.command, { cwd, stdout: '', text: '', totals: () => null }).find((a) => a.kind === 'read')
  return first ? { path: first.path, kind: 'read' } : null
}

function bashEvents(e: Rec, result: Rec, text: string, base: Base, ctx: ToolContext): FvEvent[] {
  const command = str(e.command) ?? ''
  const stdout = str(result.stdout) ?? text
  const out: FvEvent[] = bashActions(command, { cwd: ctx.cwd, home: ctx.home, cwdKnown: ctx.cwdKnown, stdout, text, totals: ctx.totals }).map((a) =>
    makeEvent({
      ...base,
      tool: a.tool,
      kind: a.kind,
      path: a.path,
      ranges: a.ranges,
      unknownRange: a.unknown || undefined,
      totalLines: a.totalLines,
      estTokens: a.estTokens,
      verified: a.verified,
      ...(a.path.startsWith(UNRESOLVED) ? { verified: false, viaFallback: true, fallbackNote: CWD_FALLBACK } : {}),
    }),
  )
  // Files Bash itself edited (e.g. sed -i), when the tool reports a diff. Not yet seen live.
  const diff = rec(result.bashEditDiff)
  if (Array.isArray(diff.files)) {
    for (const raw of diff.files) {
      const f = rec(raw)
      const counts = hunkCounts(f.hunks)
      const path = str(f.filePath)
      if (!path || !counts) continue
      out.push(makeEvent({ ...base, tool: 'Bash:edit', kind: 'edit', path: resolvePath(ctx.cwd, path), hunks: counts.hunks, linesAdded: counts.added, linesRemoved: counts.removed, estTokens: 0, verified: false }))
    }
  }
  return out
}

// ---- instruction sources -----------------------------------------------------

type InstructionFileLike = { path: string; kind: string; content: string; parent?: string }

function instructionFiles(v: unknown): InstructionFileLike[] {
  if (!Array.isArray(v)) return []
  return v
    .map(rec)
    .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path as string, kind: str(f.kind) ?? 'project', content: f.content as string, parent: str(f.parent) }))
}

/** Instruction files in a `prompt.context` result whose on-disk text the hook should read (caps, raw length). */
export function contextPaths(result: Rec): string[] {
  return instructionFiles(result.instructionFiles).map((f) => f.path).slice(0, 50)
}

/**
 * `prompt.context`: every session-start instruction file with its loaded
 * content. Use the result: files another mod added (AGENTS.md) are only there.
 */
export function contextEvents(input: Rec, result: Rec, ctx: Agent & { ts: number; afterCompact: boolean; onDisk: (path: string) => string | null }): FvEvent[] {
  const before = new Set(instructionFiles(input.instructionFiles).map((f) => f.path))
  const files = instructionFiles(result.instructionFiles ?? input.instructionFiles)
  return files.map((f) => {
    const addedByMod = !before.has(f.path)
    const agentsMd = basename(f.path) === 'AGENTS.md'
    const reason = ctx.afterCompact ? 'compact' : addedByMod ? (agentsMd ? 'agents-md' : 'added-by-mod') : f.parent ? 'include' : 'session_start'
    const fallback = agentsMd ? AGENTS_FALLBACK : f.kind === 'memory' ? MEMORY_FALLBACK : undefined
    const base = {
      ts: ctx.ts,
      agentId: ctx.agentId,
      agentType: ctx.agentType,
      kind: 'autoload' as const,
      path: f.path,
      source: 'promptContext' as const,
      estTokens: estTokens(f.content),
      origin: originOf(f.kind),
      loadReason: reason,
      parentPath: f.parent,
      // AGENTS.md never fires InstructionsLoaded, so its row always carries `?`.
      verified: !agentsMd,
      viaFallback: fallback !== undefined || undefined,
      fallbackNote: fallback,
    }
    if (f.kind === 'memory') {
      const disk = ctx.onDisk(f.path)
      if (disk !== null) {
        const loaded = sharedLeadingLines(disk, f.content)
        const total = lineCount(disk)
        return makeEvent({ ...base, ranges: loaded > 0 ? [[1, loaded]] : [], totalLines: total, capped: loaded < total })
      }
      return makeEvent({ ...base, whole: true, totalLines: lineCount(f.content), verified: false })
    }
    return makeEvent({ ...base, whole: true, ...rawBasis(f.content, ctx.onDisk(f.path)) })
  })
}

/**
 * One length basis per file: the raw file on disk. Claude Code strips rule front matter before loading,
 * so a whole load covers the raw length and notes how many lines Claude received.
 */
function rawBasis(loaded: string, disk: string | null): { totalLines: number; strippedLines?: number } {
  const got = lineCount(loaded)
  if (disk === null) return { totalLines: got }
  const raw = lineCount(disk)
  return raw === got ? { totalLines: raw } : { totalLines: raw, strippedLines: got }
}

export const MEMORY_FALLBACK = 'InstructionsLoaded does not fire for MEMORY.md (U-4); found in prompt.context'
export const AGENTS_FALLBACK = 'AGENTS.md never fires InstructionsLoaded; found in the prompt.context result'
export const CWD_FALLBACK = 'Bash directory unknown (cd "$VAR", cd -, a substitution or a glob); the relative path is not resolved to a guess'
export const SKILL_SCAN_FALLBACK = 'skill path found only by scanning skill folders (U-6)'

function originOf(kind: string): InstructionOrigin {
  return kind === 'user' || kind === 'local' || kind === 'managed' || kind === 'memory' ? kind : 'project'
}

/** `classic.InstructionsLoaded`: why and when a file loaded (no content). */
export function instructionsLoadedEvent(e: Rec, ts: number, agentType: (id: string) => string | null): FvEvent | null {
  const path = str(e.file_path)
  if (!path) return null
  const agentId = str(e.agent_id) ?? null
  const memoryType = str(e.memory_type)
  const cls = classifyPath(path)
  return makeEvent({
    ts,
    kind: 'autoload',
    path,
    source: 'instructionsLoaded',
    agentId,
    agentType: str(e.agent_type) ?? (agentId ? agentType(agentId) : null),
    estTokens: null,
    loadReason: str(e.load_reason),
    memoryType,
    origin: cls?.origin === 'memory' ? 'memory' : memoryType ? originOf(memoryType.toLowerCase()) : undefined,
    triggerPath: str(e.trigger_file_path),
    parentPath: str(e.parent_file_path),
    globs: Array.isArray(e.globs) ? e.globs.filter((g): g is string => typeof g === 'string') : undefined,
  })
}

/** `prompt.attachment`: nested instruction content, skill descriptions, post-compact restores; the rest is "other injected". */
export type AttachmentContext = Agent & {
  readonly ts: number
  readonly isInstruction: (path: string) => boolean
  /** SKILL.md of a project/user skill found by scanning skill folders (U-6), or null. */
  readonly skillPath?: (name: string) => string | null
  /** The raw text on disk of a nested instruction file, or null. */
  readonly onDisk?: (path: string) => string | null
}

export function attachmentRecords(e: Rec, text: string, ctx: AttachmentContext): LogRecord[] {
  const type = str(e.type) ?? 'unknown'
  const base = { ts: ctx.ts, agentId: ctx.agentId, agentType: ctx.agentType }
  const ev = (x: Parameters<typeof makeEvent>[0]): LogRecord => ({ t: 'event', e: makeEvent({ ...base, ...x }) })
  const injected = (tokens: number): LogRecord => ({ t: 'injected', ts: ctx.ts, type, estTokens: tokens, agentId: ctx.agentId })

  if (type === 'nested_memory') {
    const nm = parseNestedMemory(text)
    if (!nm) return [injected(estTokens(text))]
    return [ev({ kind: 'autoload', path: nm.path, source: 'attachment', estTokens: estTokens(text), whole: true, ...rawBasis(nm.content, ctx.onDisk?.(nm.path) ?? null), origin: classifyPath(nm.path)?.origin ?? 'project', loadReason: 'nested_memory' })]
  }
  if (type === 'skill_listing') {
    const { header, skills } = parseSkillListing(text)
    return [
      injected(estTokens(header)),
      ...skills.map((s) => {
        const owner = skillOwner(s.name)
        const scanned = owner.kind === 'skill' ? (ctx.skillPath?.(s.name) ?? null) : null
        return ev({
          kind: 'autoload',
          path: `skill-description:${s.name}`,
          source: 'attachment',
          estTokens: estTokens(s.text),
          whole: true,
          totalLines: lineCount(s.text),
          origin: 'skillDescription',
          owner,
          loadReason: 'skill_listing',
          ...(scanned ? { resolvedPath: scanned, viaFallback: true, fallbackNote: SKILL_SCAN_FALLBACK, verified: false } : {}),
        })
      }),
    ]
  }
  if (type === 'invoked_skills') {
    // After /compact Claude Code re-sends the skills invoked earlier, each with its "Base directory" line.
    const parts = text.split(/(?=Base directory for this skill: )/)
    const records: LogRecord[] = []
    let header = ''
    for (const part of parts) {
      const dir = skillBaseDir(part)
      if (!dir) {
        header += part
        continue
      }
      const name = dir.slice(dir.lastIndexOf('/') + 1)
      const owner = skillOwner(name)
      records.push(
        ev({
          kind: 'skillLoad',
          tool: 'n/a',
          path: `${dir}/SKILL.md`,
          source: 'compactRestore',
          estTokens: estTokens(part),
          whole: true,
          origin: owner.kind === 'plugin' ? 'plugin' : 'skill',
          owner: owner.kind === 'plugin' ? owner : { kind: 'skill', name },
          loadReason: 'compact',
        }),
      )
    }
    return [injected(estTokens(header)), ...records]
  }
  if (type === 'file') {
    const restored = parseRestoredRead(text)
    if (!restored) return [injected(estTokens(text))]
    const range = numberedRange(restored.body)
    const ranges = range ? [range] : []
    if (ctx.isInstruction(restored.path)) {
      // A whole-file restore numbers the raw file (rule front matter included): its last line is the file's length.
      const whole = restored.offset === null && restored.limit === null && range !== null
      return [ev({ kind: 'autoload', path: restored.path, source: 'compactRestore', estTokens: estTokens(text), ranges, loadReason: 'compact', ...(whole ? { totalLines: range[1] } : {}) })]
    }
    return [ev({ kind: 'read', tool: 'n/a', path: restored.path, source: 'compactRestore', estTokens: estTokens(text), ranges, loadReason: 'compact' })]
  }
  return [injected(estTokens(text))]
}

/** `skill.prompt`: the SKILL.md body Claude received when the skill ran. */
export function skillPromptEvent(skill: string, text: string, ctx: Agent & { ts: number }): FvEvent {
  const dir = skillBaseDir(text)
  const owner = skillOwner(skill)
  return makeEvent({
    ...ctx,
    kind: 'skillLoad',
    tool: 'Skill',
    path: dir ? `${dir}/SKILL.md` : `skill:${skill}/SKILL.md`,
    source: 'skillPrompt',
    estTokens: estTokens(text),
    whole: true,
    origin: owner.kind === 'plugin' ? 'plugin' : 'skill',
    owner: owner.kind === 'plugin' ? owner : { kind: 'skill', name: skill },
    loadReason: 'skill_invoked',
    verified: dir !== null,
  })
}

// ---- git scan ------------------------------------------------------------------

type GitChange = { readonly path: string; readonly letter: string; readonly added: number; readonly removed: number }

/** Files a Bash call changed, as the status scan after it saw them: new files are writes, the rest edits. */
export function bashWriteEvents(changed: readonly GitChange[], prev: (path: string) => GitChange | undefined, ctx: Agent & { ts: number }): FvEvent[] {
  return changed.slice(0, 200).map((c) => {
    const before = prev(c.path)
    return makeEvent({
      ...ctx,
      kind: c.letter === '?' || c.letter === 'A' ? 'write' : 'edit',
      tool: 'Bash:write',
      path: c.path,
      source: 'gitScan',
      linesAdded: Math.max(0, c.added - (before?.added ?? 0)),
      linesRemoved: Math.max(0, c.removed - (before?.removed ?? 0)),
      estTokens: 0,
    })
  })
}

/** One `commit` event per file the commit touched. */
export function commitEvents(paths: readonly string[], sha: string, ctx: Agent & { ts: number }): FvEvent[] {
  return paths.slice(0, 500).map((path) => makeEvent({ ...ctx, kind: 'commit', tool: 'git commit', path, source: 'gitScan', sha, estTokens: 0 }))
}
