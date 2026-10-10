// View-model figures shared by the panel's tabs, detail view and footer.
// Every token figure here is rendered through fmtEstTokens/fmtExactTokens.
import { coverageRatio, coveredLines, formatRanges } from './intervals.ts'
import type { FileState, SessionState } from './model.ts'
import { basename } from './paths.ts'
import { EXACT_MARKER, fmtEstTokens, fmtExactTokens } from './tokens.ts'

/** Detail-view range line: `1–200 / 1,323`; `? / 1,323` style when parts are unknown. */
export function rangeSummary(f: FileState): string {
  const ranges = f.intervals.length > 0 ? formatRanges(f.intervals) : f.unknownRead ? '?' : '—'
  const total = f.totalLines === null ? '?' : f.totalLines.toLocaleString('en-US')
  return `${ranges} / ${total}`
}

/** Lines read (the merged read intervals) and the file's total; null when the total or the lines are unknown. */
export function linesRead(f: FileState): { read: number; total: number } | null {
  if (f.totalLines === null) return null
  const read = f.intervals.length > 0 ? coveredLines(f.intervals, f.totalLines) : f.coverage === 'full' ? f.totalLines : 0
  return read > 0 ? { read, total: f.totalLines } : null
}

/** Coverage percent, rounded; null when the file length is unknown. */
export function coveragePercent(f: FileState): number | null {
  if (f.totalLines === null) return f.coverage === 'full' ? 100 : null
  const r = coverageRatio(f.intervals, f.totalLines)
  return r === null ? null : Math.round(r * 100)
}

export type InstructionGroups = {
  /** Loaded by Claude Code on its own (⚡). */
  auto: FileState[]
  /** Per skill: its description, SKILL.md and supporting files. */
  skills: Map<string, FileState[]>
  /** Plugin-owned rows and instruction files only read via a tool. */
  other: FileState[]
}

export function instructionGroups(s: SessionState): InstructionGroups {
  const groups: InstructionGroups = { auto: [], skills: new Map(), other: [] }
  for (const f of s.files.values()) {
    if (!f.instruction) continue
    if (f.owner?.kind === 'skill') {
      const list = groups.skills.get(f.owner.name) ?? []
      list.push(f)
      groups.skills.set(f.owner.name, list)
    } else if (f.owner?.kind === 'plugin' || f.instruction.mode === 'tool') groups.other.push(f)
    else groups.auto.push(f)
  }
  return groups
}

export type Totals = {
  /** Instruction rows: auto + skill + other. */
  instructionTokens: number
  /** Instruction rows' share of what is in context now. */
  instructionContextTokens: number
  /** Every file's reads + auto-loads this session, compactions included (cumulative). */
  readTokens: number
  /** What files hold in the main context now: loads and reads since the last compaction. */
  contextTokens: number
  /** Edit/Write payloads, never part of cost. */
  writtenTokens: number
  autoCount: number
  skillCount: number
  touched: number
}

export function totals(s: SessionState): Totals {
  const g = instructionGroups(s)
  const rows = [...g.auto, ...[...g.skills.values()].flat(), ...g.other]
  let readTokens = 0
  let contextTokens = 0
  let writtenTokens = 0
  let touched = 0
  for (const f of s.files.values()) {
    readTokens += f.estTokens
    if (f.inContext) contextTokens += f.contextTokens
    writtenTokens += f.writtenTokens
    if (f.lastAction !== null) touched += 1
  }
  return {
    instructionTokens: rows.reduce((n, f) => n + f.estTokens, 0),
    instructionContextTokens: rows.reduce((n, f) => n + (f.inContext ? f.contextTokens : 0), 0),
    readTokens,
    contextTokens,
    writtenTokens,
    autoCount: g.auto.length,
    skillCount: g.skills.size,
    touched,
  }
}

/** Instructions-tab summary: `3 auto · 1 skills · ≈2.4k tok of ≈9.1k read`. */
export function instructionSummaryLine(s: SessionState): string {
  const t = totals(s)
  const line = `${t.autoCount} auto · ${t.skillCount} skills · ${fmtEstTokens(t.instructionTokens)} of ${fmtEstTokens(t.readTokens)} read`
  // After a compaction the cumulative figure and what is in context now differ: show both.
  return t.instructionContextTokens === t.instructionTokens ? line : `${line} · ${fmtEstTokens(t.instructionContextTokens)} in context`
}

/**
 * One footer figure. Row 0 leads with the latest request's context size (the
 * primary number); row 1 holds the summed and estimated figures. A part is
 * drawn whole or dropped, lowest `priority` first, so a label never wraps away
 * from its number.
 */
export type FooterPart = { readonly text: string; readonly row: 0 | 1; readonly priority: number; readonly primary?: boolean }

/** Footer parts, in display order. `notes`: the latest action (`committed <sha7>`) and view state. */
export function footerParts(s: SessionState, notes: readonly string[]): FooterPart[] {
  const t = totals(s)
  const parts: FooterPart[] = []
  if (s.latestContext !== null) parts.push({ text: `context ${fmtExactTokens(s.latestContext, { short: true })}`, row: 0, priority: 100, primary: true })
  // `=` marks exact figures only where its legend shows; it outranks every part but the context.
  if (s.usage.requests > 0) parts.push({ text: `${EXACT_MARKER} exact`, row: 0, priority: 95 })
  notes.forEach((text, i) => parts.push({ text, row: 0, priority: 90 - i * 10 }))
  if (s.usage.requests > 0) parts.push({ text: `out ${fmtExactTokens(s.usage.output, { short: true })}`, row: 0, priority: 60 })
  // Every request re-reads the cached context, so this sum is far larger than the context: never call it context.
  if (s.usage.requests > 0) parts.push({ text: `billed ∑ ${fmtExactTokens(s.billedSum, { short: true })} incl. cache re-reads`, row: 1, priority: 70 })
  // Two file totals: what files hold in the context now, and everything loaded this session.
  parts.push({ text: `in context ${fmtEstTokens(t.contextTokens)}`, row: 1, priority: 55 })
  parts.push({ text: `loaded ∑ ${fmtEstTokens(t.readTokens)}`, row: 1, priority: 45 })
  if (s.latestContext) parts.push({ text: `≈ attributed to files: ${Math.min(100, Math.round((t.contextTokens / s.latestContext) * 100))}%`, row: 1, priority: 40 })
  if (t.writtenTokens > 0) parts.push({ text: `written ${fmtEstTokens(t.writtenTokens)}`, row: 1, priority: 30 })
  // Claude Code's internal forks (no SubagentStart): their loads, apart from the file totals.
  if (s.otherAgents.estTokens > 0) parts.push({ text: `other agents ${fmtEstTokens(s.otherAgents.estTokens)}`, row: 1, priority: 20 })
  return parts
}

/** The footer as one line of text (logs, scripts). */
export function footerLine(s: SessionState): string {
  return footerParts(s, []).map((p) => p.text).join(' · ')
}

/** `?` for a row whose detection isn't confirmed on a live build yet. */
export function unverifiedMark(f: FileState): string {
  // An AGENTS.md row always carries `?`, whatever detected it.
  if (f.instruction && basename(f.path) === 'AGENTS.md') return '?'
  return f.verified && (f.instruction?.verified ?? true) ? '' : '?'
}
