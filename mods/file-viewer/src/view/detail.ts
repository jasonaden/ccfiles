// The detail view for one file: exact ranges, read vs
// authored lines, per-action history, load reasons, fallbacks, and the
// estimate legend. Lines of named-color chips; the hook draws them.
import type { GitSnapshot } from '../git.ts'
import { formatRanges, subtract } from '../intervals.ts'
import { ATTRIBUTION, MAIN, agentLabel, agentTable, trackCoverage } from '../agents.ts'
import type { FileState, FvEvent, SessionState } from '../model.ts'
import { coveragePercent, linesRead, rangeSummary, unverifiedMark } from '../summary.ts'
import { ESTIMATE_LEGEND, ESTIMATE_MARKER, EXACT_MARKER, fmtEstTokens, fmtExactTokens } from '../tokens.ts'
import { GLYPH_TABLE, KEY_TABLE, META_WORDS } from './glyphs.ts'
import { displayPath, type Chip } from './rows.ts'

export type DetailLine = readonly Chip[]

const label = (text: string): Chip => ({ text: text.padEnd(10), color: 'muted' })
const plain = (text: string): Chip => ({ text, color: 'text' })

function time(ts: number): string {
  const d = new Date(ts)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

function eventRange(e: FvEvent): string {
  if (e.stub) return 'already in context'
  if (e.unknownRange) return 'lines ?'
  if (e.ranges.length > 0) return formatRanges(e.ranges)
  if (e.whole) return 'whole'
  if (e.kind === 'edit' || e.kind === 'write') return `+${e.linesAdded} −${e.linesRemoved}`
  return '—'
}

function agentName(e: FvEvent, internal: ReadonlySet<string>, label?: (id: string) => string | null): string {
  if (e.agentId === null) return 'main'
  return label?.(e.agentId) ?? `${e.agentType || (internal.has(e.agentId) ? 'internal' : 'agent')}#${e.agentId.slice(0, 6)}`
}

/** What reported a load Claude Code made on its own. */
const SOURCE_LABEL: Record<FvEvent['source'], string> = {
  tool: 'tool',
  instructionsLoaded: 'InstructionsLoaded',
  promptContext: 'prompt.context',
  attachment: 'attachment',
  skillPrompt: 'skill.prompt',
  compactRestore: 'compact restore',
  session: 'session',
  gitScan: 'git scan',
}

function historyLine(e: FvEvent, internal: ReadonlySet<string>, label?: (id: string) => string | null): DetailLine {
  const outcome = e.outcome === 'ok' ? '' : e.outcome === 'denied' ? ' ✗ denied' : ' ✗ error'
  const what = e.tool === 'n/a' ? SOURCE_LABEL[e.source] : e.kind === 'read' || e.kind === 'autoload' || e.kind === 'skillLoad' ? e.tool : `${e.tool} ${e.kind}`
  // An InstructionsLoaded carries no content: its tokens come with the content event.
  const tokens = e.estTokens === null ? (e.source === 'instructionsLoaded' ? '' : fmtEstTokens(null)) : e.estTokens > 0 ? fmtEstTokens(e.estTokens) : ''
  const reason = e.loadReason ? ` (${e.loadReason}${e.source === 'compactRestore' ? ', restored' : ''})` : ''
  return [
    { text: time(e.ts) + ' ', color: 'muted' },
    { text: what + reason + ' ', color: e.outcome === 'ok' ? 'text' : 'error' },
    { text: eventRange(e), color: 'muted' },
    { text: outcome, color: 'error' },
    ...(tokens ? [{ text: ' ' + tokens, color: 'muted' as const }] : []),
    { text: ' ' + agentName(e, internal, label), color: 'muted' },
  ]
}

/** Session-wide exact usage, shown in full in every detail view (the footer shows it short); the registry names agents. */
type SessionUsage = Pick<SessionState, 'latestContext' | 'billedSum' | 'usage'> & Partial<Pick<SessionState, 'registry'>>

export type DetailContext = {
  readonly root: string
  readonly home: string | null
  readonly git: GitSnapshot | null
  readonly themeHint: string | null
  /** Agents with no known type (Claude Code's own forks): labeled `internal#…`, not counted. */
  readonly otherAgents?: ReadonlySet<string>
  readonly session?: SessionUsage
}

export function detailLines(f: FileState, ctx: DetailContext): DetailLine[] {
  const lines: DetailLine[] = []
  const pct = coveragePercent(f)
  lines.push([{ text: displayPath(f.path, ctx.root, ctx.home), color: 'accent' }, { text: ` ${unverifiedMark(f)}`, color: 'accent' }])
  if (f.path.startsWith('/') && f.path !== displayPath(f.path, ctx.root, ctx.home)) lines.push([{ text: f.path, color: 'muted' }])
  const counted = linesRead(f)
  lines.push([
    label('lines'),
    plain(rangeSummary(f)),
    { text: pct === null ? '' : ` · ${pct}%`, color: 'text' },
    { text: counted ? ` · ${counted.read.toLocaleString('en-US')}/${counted.total.toLocaleString('en-US')} lines read` : '', color: 'text' },
    { text: ` · ${f.coverage}`, color: 'muted' },
  ])
  // The exact share as a mini bar, eighth blocks over 10 cells (80 steps).
  if (pct !== null) lines.push([label('coverage'), { text: miniBar(pct / 100), color: 'read' }, { text: ` ${pct}%`, color: 'text' }])
  const read = subtract(f.intervals, f.authored)
  if (f.authored.length > 0) {
    lines.push([label('read'), plain(read.length > 0 ? formatRanges(read) : '—')])
    lines.push([label('authored'), { text: formatRanges(f.authored), color: 'edit' }, { text: ' (written by Claude; no read cost)', color: 'muted' }])
  }
  lines.push([
    label('tokens'),
    plain(fmtEstTokens(f.estTokens)),
    { text: ` · reads ${f.reads}${f.rereads > 0 ? ` · ↩${f.rereads} re-read` : ''}${f.stubs > 0 ? ` · ${f.stubs} already-in-context stub` : ''}${f.hits > 0 ? ` · ${f.hits} search hit` : ''}`, color: 'muted' },
  ])
  if (f.outOfContext) {
    lines.push([label('context'), { text: '⊘ out of context since compaction', color: 'accent' }, { text: ' (not re-injected; history kept, not in the in-context total)', color: 'muted' }])
  } else if (f.inContext && f.contextTokens !== f.estTokens) {
    lines.push([label('context'), plain(`${fmtEstTokens(f.contextTokens)} in context now`), { text: ' (since the last compaction)', color: 'muted' }])
  }
  if (f.writtenTokens > 0 || f.edits + f.writes > 0) {
    lines.push([label('written'), { text: `${fmtEstTokens(f.writtenTokens)} (not cost) · +${f.linesAdded} −${f.linesRemoved} this session`, color: 'edit' }])
  }
  const g = ctx.git?.files.get(f.path)
  if (g) lines.push([label('git'), { text: `${g.letter} +${g.added} −${g.removed}${g.staged ? ' (staged)' : ''}`, color: 'text' }])
  const i = f.instruction
  if (i) {
    lines.push([label('mode'), { text: i.mode === 'tool' ? 'read via tool' : i.mode === 'both' ? '⚡ auto-loaded and read via tool' : '⚡ auto-loaded', color: 'instruction' }, { text: ` · ${i.origin}`, color: 'muted' }])
    if (i.loads > 0) lines.push([label('loads'), plain(String(i.loads)), { text: i.loadReasons.length ? ` · ${i.loadReasons.join(', ')}` : '', color: 'muted' }])
    if (i.triggerPath) lines.push([label('trigger'), plain(displayPath(i.triggerPath, ctx.root, ctx.home))])
    if (i.parentPath) lines.push([label('parent'), plain(displayPath(i.parentPath, ctx.root, ctx.home))])
    if (i.globs.length) lines.push([label('globs'), plain(i.globs.join(', '))])
    if (i.capped) lines.push([label('capped'), { text: 'Claude Code loaded only part of this file', color: 'muted' }])
    if (i.strippedLines !== null) lines.push([label('loaded'), plain(`${i.strippedLines} lines`), { text: ' (front matter stripped by Claude Code; lines count the raw file)', color: 'muted' }])
    if (i.resolvedPath) lines.push([label('path'), plain(displayPath(i.resolvedPath, ctx.root, ctx.home))])
  }
  if (f.owner) lines.push([label('owner'), plain(`${f.owner.kind} ${f.owner.name}`)])
  if (f.reloads > 0) lines.push([label('reloaded'), { text: `⟳ ${f.reloads}× after /compact`, color: 'instruction' }])
  if (f.viaFallback) lines.push([{ text: `? detected via fallback: ${f.viaFallback}`, color: 'accent' }])
  else if (unverifiedMark(f)) lines.push([{ text: '? unverified: the path or lines rest on a detection not confirmed live', color: 'accent' }])
  if (f.denied + f.errors > 0) lines.push([label('blocked'), { text: `${f.denied} denied · ${f.errors} errored (no coverage)`, color: 'error' }])
  const registry = ctx.session?.registry
  const name = (id: string) => registry?.get(id)?.label ?? null
  if (f.via && f.via.length > 0) lines.push([label('via'), plain(f.via.join(', ')), { text: ' (seen by other agents; their share is in their own views)', color: 'muted' }])
  // What each agent saw, kept apart (shown once a subagent took part).
  if ([...f.byAgent.keys()].some((k) => k !== MAIN)) {
    lines.push([])
    lines.push([{ text: 'by agent', color: 'muted' }])
    for (const [key, tr] of f.byAgent) {
      const who = key === MAIN ? 'main' : name(key) ?? `agent#${key.slice(0, 6)}`
      const ranges = tr.intervals.length > 0 ? formatRanges(tr.intervals) : tr.unknownRead ? 'lines ?' : tr.hits > 0 ? 'search hit' : '—'
      lines.push([
        { text: who.padEnd(12), color: 'text' },
        plain(ranges),
        { text: ` · ${trackCoverage(tr, f.totalLines)} · reads ${tr.reads}${tr.rereads > 0 ? ` · ↩${tr.rereads}` : ''} · `, color: 'muted' },
        { text: fmtEstTokens(tr.estTokens), color: 'muted' },
      ])
    }
  }
  lines.push([])
  lines.push([{ text: 'history', color: 'muted' }])
  for (const e of [...f.history].reverse()) lines.push(historyLine(e, ctx.otherAgents ?? new Set(), name))
  const u = ctx.session
  if (u && u.usage.requests > 0) {
    lines.push([])
    lines.push([{ text: 'session (exact API usage)', color: 'muted' }])
    if (u.latestContext !== null) lines.push([label('context'), plain(fmtExactTokens(u.latestContext)), { text: ' (latest request)', color: 'muted' }])
    lines.push([label('billed'), plain(`∑ ${fmtExactTokens(u.billedSum)} incl. cache re-reads`)])
    lines.push([label('out'), plain(fmtExactTokens(u.usage.output))])
  }
  lines.push([])
  lines.push([{ text: `${ESTIMATE_MARKER} ${ESTIMATE_LEGEND} · ${EXACT_MARKER} exact (API usage)`, color: 'muted' }])
  if (ctx.themeHint) lines.push([{ text: ctx.themeHint, color: 'muted' }])
  lines.push(...helpLines())
  return lines
}

/** The agents view (`u`): per agent its files, ≈ tokens and exact usage; the rows add up to the total. */
export function agentLines(s: SessionState): DetailLine[] {
  const t = agentTable(s)
  const row = (who: string, files: string, est: number, billed: number, out: number, note: string, color: Chip['color'] = 'text'): DetailLine => [
    { text: who.padEnd(12), color },
    { text: files.padStart(5) + '  ', color: 'muted' },
    { text: fmtEstTokens(est).padEnd(11), color },
    { text: `${fmtExactTokens(billed, { short: true })} billed`.padEnd(14), color },
    { text: `${fmtExactTokens(out, { short: true })} out`, color },
    { text: note ? `  ${note}` : '', color: 'muted' },
  ]
  const lines: DetailLine[] = [[{ text: 'agents', color: 'text' }], [{ text: `${'agent'.padEnd(12)}files  ${'≈ read'.padEnd(11)}${'= billed'.padEnd(14)}= out`, color: 'muted' }]]
  for (const r of t.rows) {
    const a = r.key === MAIN ? null : s.registry.get(r.key)
    const parent = a?.parentId ? ` · from ${agentLabel(s, a.parentId)}` : ''
    const when = r.status === 'done' && r.start !== null && r.end !== null ? `done in ${Math.max(0, Math.round((r.end - r.start) / 1000))}s` : r.status ?? ''
    lines.push(row(r.label, String(r.files), r.estTokens, r.billed, r.usage.output, `${when}${parent}`))
    if (a?.description) lines.push([{ text: `${''.padEnd(12)}${a.description}`, color: 'muted' }])
  }
  if (t.other) lines.push(row('other', '', t.other.estTokens, t.other.billed, t.other.usage.output, "Claude Code's own forks", 'muted'))
  lines.push(row('total', '', t.total.estTokens, t.total.billed, t.total.output, ''))
  lines.push([])
  lines.push([{ text: `${ESTIMATE_MARKER} ${ESTIMATE_LEGEND} · ${EXACT_MARKER} exact (API usage, input + cache read + cache creation)`, color: 'muted' }])
  lines.push([{ text: `attribution: ${ATTRIBUTION}`, color: 'muted' }])
  return lines
}

/**
 * The whole help view: a title, the help lines, then what left the footer: the billed session sum
 * (exact) and, once a subagent ran, the per-agent usage table.
 */
export function helpView(s?: SessionState, o: { palette?: 'hex' | 'theme' } = {}): DetailLine[] {
  const out: DetailLine[] = [[{ text: 'help', color: 'text' }, { text: '  ? or g closes · keys work after a click in the list, or with the pane focused (ctrl+x tab)', color: 'muted' }], ...helpLines()]
  // Which keys need a click in the list first.
  out.push([{ text: 'click', color: 'text' }, { text: '  letters and digits work with no click once the pane has focus; arrows, PgUp/PgDn, Home/End and Enter need a click in the list', color: 'muted' }])
  out.push(
    [],
    [{ text: 'header', color: 'muted' }],
    ...HEADER_BUTTONS.map((b): DetailLine => [{ text: b.glyph, color: 'text' }, { text: `  ${b.meaning}`, color: 'muted' }]),
    [],
    [{ text: 'columns', color: 'muted' }],
    [{ text: 'gutter', color: 'text' }, { text: "  Claude's state, then a subagent badge (E Explore · G general-purpose · P Plan · C custom · + several · m main)", color: 'muted' }],
    [{ text: 'icon', color: 'text' }, { text: '  file type (Nerd Font, or ■ folder · file); name colour = git state', color: 'muted' }],
    [{ text: 'Σ', color: 'text' }, { text: `  right column: ${ESTIMATE_MARKER}tokens (${ESTIMATE_LEGEND}) → lines read/total → date → size`, color: 'muted' }],
    // Theme keys can't be contrast-checked; say where the colours come from.
    [{ text: 'colours', color: 'text' }, { text: o.palette === 'theme' ? '  palette: theme — text colours follow your Claude Code theme' : '  palette: hex — the viewer\'s own colours (palette: theme follows your Claude Code theme)', color: 'muted' }],
  )
  if (s && s.usage.requests > 0) {
    out.push([], [{ text: 'session', color: 'muted' }], [{ text: `billed ∑ ${fmtExactTokens(s.billedSum, { short: true })}`, color: 'text' }, { text: ` exact, incl. cache re-reads (never the context size) · out ${fmtExactTokens(s.usage.output, { short: true })}`, color: 'muted' }])
  }
  if (s && s.registry.size > 0) out.push([], ...agentLines(s))
  return out
}

/** The header's icon buttons, as the help view lists them. */
const HEADER_BUTTONS: readonly { readonly glyph: string; readonly meaning: string }[] = [
  { glyph: '?', meaning: 'this help (key g)' },
  { glyph: '↑', meaning: 'focus the parent folder (may go above the session root)' },
  { glyph: '⌂', meaning: 'back to the session root' },
  { glyph: '↻', meaning: 'refresh git now' },
  { glyph: '◉', meaning: 'follow Claude: bright while following, dim while paused (key f)' },
  { glyph: 'Σ', meaning: 'cycle the right column' },
  { glyph: '⊟ ⊞', meaning: 'collapse every folder / back to the default view' },
]

/** The help view (`g`): the keys, every glyph of the table and every meta word a row can show. */
export function helpLines(): DetailLine[] {
  return [
    [],
    [{ text: 'keys', color: 'muted' }],
    ...KEY_TABLE.map((k): DetailLine => [{ text: k.keys, color: 'text' }, { text: `  ${k.meaning}`, color: 'muted' }]),
    [],
    [{ text: 'key', color: 'muted' }],
    ...GLYPH_TABLE.map((g): DetailLine => [{ text: g.glyph, color: g.color }, { text: `  ${g.meaning}`, color: 'muted' }]),
    ...META_WORDS.map((m): DetailLine => [{ text: m.text, color: 'text' }, { text: `  ${m.meaning}`, color: 'muted' }]),
  ]
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** `▕████▍     ▏`: `fraction` of `cells` cells filled in eighths, framed; always `cells + 2` wide. */
export function miniBar(fraction: number, cells = 10): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  let eighths = Math.round(f * cells * 8)
  // A sliver read never draws empty, and a nearly complete one never draws full.
  if (f > 0 && eighths === 0) eighths = 1
  if (f < 1 && eighths === cells * 8) eighths -= 1
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  return `▕${'█'.repeat(full)}${part}${' '.repeat(cells - full - (part ? 1 : 0))}▏`
}
