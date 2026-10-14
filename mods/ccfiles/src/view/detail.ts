// The detail view for one file: exact ranges, read vs
// authored lines, per-action history, load reasons, fallbacks, and the
// estimate legend. Lines of named-color chips; the hook draws them.
import type { GitSnapshot } from '../git.ts'
import { formatRanges, subtract } from '../intervals.ts'
import { ATTRIBUTION, MAIN, agentLabel, agentTable, trackCoverage } from '../agents.ts'
import type { FileState, FvEvent, SessionState } from '../model.ts'
import { coveragePercent, linesRead, rangeSummary, unverifiedMark } from '../summary.ts'
import { ESTIMATE_LEGEND, ESTIMATE_MARKER, EXACT_MARKER, fmtEstTokens, fmtExactTokens } from '../tokens.ts'
import { GLYPHS, GLYPH_TABLE, KEY_TABLE, METER, META_WORDS } from './glyphs.ts'
import { displayPath, type Chip } from './rows.ts'
import { blockLines, type Block, type DetailLine } from './blocks.ts'
import { basename } from '../paths.ts'
import type { ColorKey } from '../palette.ts'

export type { DetailLine } from './blocks.ts'

const muted = (text: string): Chip => ({ text, color: 'muted' })
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

/** What a history row calls its action. */
function actionLabel(e: FvEvent): string {
  if (e.tool.startsWith('Bash:')) return `Bash: ${e.tool.slice(5)}`
  if (e.kind === 'read' || e.kind === 'autoload' || e.kind === 'skillLoad' || e.tool.toLowerCase() === e.kind) return e.tool
  return `${e.tool} ${e.kind}`
}

function historyRow(e: FvEvent, internal: ReadonlySet<string>, label?: (id: string) => string | null): (readonly Chip[])[] {
  const outcome = e.outcome === 'ok' ? '' : e.outcome === 'denied' ? ' ✗ denied' : ' ✗ error'
  // The tool names the action: `Read`, `Edit`, and a shell command by its program (`Bash: sed`); the kind is added
  // only where the tool doesn't already say it (`NotebookEdit write`).
  const what = e.tool === 'n/a' ? SOURCE_LABEL[e.source] : actionLabel(e)
  // An InstructionsLoaded carries no content: its tokens come with the content event.
  const tokens = e.estTokens === null ? (e.source === 'instructionsLoaded' ? '' : fmtEstTokens(null)) : e.estTokens > 0 ? fmtEstTokens(e.estTokens) : ''
  const reason = e.loadReason ? ` (${e.loadReason}${e.source === 'compactRestore' ? ', restored' : ''})` : ''
  return [
    [muted(time(e.ts))],
    [{ text: what + reason, color: e.outcome === 'ok' ? (e.kind === 'edit' || e.kind === 'write' ? 'edit' : 'text') : 'error' }, ...(outcome ? [{ text: outcome, color: 'error' as const }] : [])],
    [muted(eventRange(e))],
    [muted(tokens.replace(/ tok$/, ''))],
    [muted(agentName(e, internal, label))],
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

/** A file's detail view, as lines for the terminal. */
export function detailLines(f: FileState, ctx: DetailContext): DetailLine[] {
  return blockLines(detailBlocks(f, ctx))
}

/** How many of a thing, in words: `once`, `twice`, `3 times`. */
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/**
 * A file's detail view: its name and path, its states as chips, how much was read and what it cost as stat cards,
 * where the lines read sit in the file, what Claude Code loaded it for, and its history as a table.
 */
export function detailBlocks(f: FileState, ctx: DetailContext): Block[] {
  const blocks: Block[] = []
  const shown = displayPath(f.path, ctx.root, ctx.home)
  const name = basename(f.path)
  blocks.push({ kind: 'title', name, path: shown === name && f.path.startsWith('/') ? f.path : shown, mark: unverifiedMark(f) })

  const registry = ctx.session?.registry
  const who = (id: string) => (id === MAIN ? 'main' : registry?.get(id)?.label ?? `agent#${id.slice(0, 6)}`)
  const chips: Chip[] = []
  const g = ctx.git?.files.get(f.path)
  if (f.edits + f.writes > 0) chips.push({ text: `✎ edited ${times(f.edits + f.writes)}`, color: 'edit' })
  if (g) chips.push({ text: g.added + g.removed > 0 ? `+${g.added} −${g.removed} ${g.staged ? 'staged' : 'uncommitted'}` : `git ${g.letter}${g.staged ? ' staged' : ''}`, color: 'git.M' })
  const i = f.instruction
  if (i) chips.push({ text: i.mode === 'tool' ? 'read via tool' : i.mode === 'both' ? '⚡ auto-loaded and read via tool' : '⚡ auto-loaded', color: 'instruction' }, muted(i.origin))
  const others = [...f.byAgent.keys()].filter((k) => k !== MAIN)
  if (others.length) chips.push({ text: `also read by ${others.map(who).join(', ')}`, color: 'muted' })
  if (f.via && f.via.length > 0) chips.push({ text: `seen by ${f.via.join(', ')}`, color: 'muted' })
  if (f.outOfContext) chips.push({ text: '⊘ out of context since compaction', color: 'accent' })
  if (f.reloads > 0) chips.push({ text: `⟳ reloaded ${times(f.reloads)} after /compact`, color: 'instruction' })
  if (f.viaFallback) chips.push({ text: `? detected via fallback: ${f.viaFallback}`, color: 'accent' })
  else if (unverifiedMark(f)) chips.push({ text: '? unverified: rests on a detection not confirmed live', color: 'accent' })
  if (f.denied + f.errors > 0) chips.push({ text: `${f.denied} denied · ${f.errors} errored`, color: 'error' })
  if (chips.length) blocks.push({ kind: 'chips', chips })

  const pct = coveragePercent(f)
  const counted = linesRead(f)
  const lines = f.totalLines === null ? null : f.totalLines.toLocaleString('en-US')
  blocks.push({
    kind: 'stats',
    items: [
      {
        label: 'read',
        value: pct === null ? (f.unknownRead ? '?' : '—') : `${pct}%`,
        sub: counted ? `${counted.read.toLocaleString('en-US')}/${counted.total.toLocaleString('en-US')} lines read` : lines ? `of ${lines} lines` : 'length unknown',
      },
      {
        label: 'tokens',
        value: fmtEstTokens(f.estTokens).replace(/ tok$/, ''),
        sub: f.inContext && f.contextTokens !== f.estTokens ? `${fmtEstTokens(f.contextTokens).replace(/ tok$/, '')} in context now` : 'estimate',
      },
      { label: 'activity', value: `${f.reads} · ${f.edits + f.writes}`, sub: `reads · edits${f.rereads > 0 ? ` · ↩${f.rereads}` : ''}${f.hits > 0 ? ` · ${f.hits} hits` : ''}` },
    ],
  })

  // Where the reads and edits sit: main's reads, other agents' reads, then the lines Claude wrote over them.
  if (f.totalLines !== null && f.totalLines > 0 && (f.intervals.length > 0 || f.authored.length > 0)) {
    const spans: { from: number; to: number; color: ColorKey }[] = []
    const mainTrack = f.byAgent.get(MAIN)
    const mainRanges = others.length && mainTrack ? mainTrack.intervals : f.intervals
    for (const [a, b] of mainRanges) spans.push({ from: a, to: b, color: 'read' })
    for (const k of others) for (const [a, b] of f.byAgent.get(k)!.intervals) spans.push({ from: a, to: b, color: 'search' })
    for (const [a, b] of f.authored) spans.push({ from: a, to: b, color: 'edit' })
    const read = subtract(f.intervals, f.authored)
    blocks.push({
      kind: 'strip',
      total: f.totalLines,
      spans,
      ranges: [{ text: read.length ? formatRanges(read) : '—', color: 'text' }, ...(f.authored.length ? [muted(' · wrote '), { text: formatRanges(f.authored), color: 'edit' as const }] : [])],
      legend: [
        { text: '█', color: 'read' }, muted(others.length ? ' read by main' : ' read'),
        ...(others.length ? [muted('   '), { text: '█', color: 'search' as const }, muted(' by other agents')] : []),
        ...(f.authored.length ? [muted('   '), { text: '█', color: 'edit' as const }, muted(' written by Claude, no read cost')] : []),
      ],
    })
  }

  // What Claude Code loaded it for, and anything else that has no card: one term table.
  const facts: { term: Chip; meaning: Chip[] }[] = []
  const fact = (t: string, ...m: Chip[]) => facts.push({ term: muted(t), meaning: m })
  if (i) {
    if (i.loads > 0) fact('loads', plain(String(i.loads)), ...(i.loadReasons.length ? [muted(` · ${i.loadReasons.join(', ')}`)] : []))
    if (i.triggerPath) fact('trigger', plain(displayPath(i.triggerPath, ctx.root, ctx.home)))
    if (i.parentPath) fact('parent', plain(displayPath(i.parentPath, ctx.root, ctx.home)))
    if (i.globs.length) fact('globs', plain(i.globs.join(', ')))
    if (i.capped) fact('capped', muted('Claude Code loaded only part of this file'))
    if (i.strippedLines !== null) fact('loaded', plain(`${i.strippedLines} lines`), muted(' (front matter stripped; line counts are the raw file)'))
    if (i.resolvedPath) fact('path', plain(displayPath(i.resolvedPath, ctx.root, ctx.home)))
  }
  if (f.owner) fact('owner', plain(`${f.owner.kind} ${f.owner.name}`))
  if (f.writtenTokens > 0) fact('written', { text: `${fmtEstTokens(f.writtenTokens)} (not cost) · +${f.linesAdded} −${f.linesRemoved} this session`, color: 'edit' })
  if (facts.length) blocks.push({ kind: 'terms', ...(i ? { title: 'Loaded by Claude Code' } : {}), rows: facts })

  // What each agent saw, kept apart (once a subagent took part).
  if (others.length) {
    blocks.push({
      kind: 'table',
      title: 'By agent',
      columns: [{ label: 'AGENT' }, { label: 'LINES' }, { label: 'READS', right: true }, { label: '≈TOKENS', right: true }],
      rows: [...f.byAgent].map(([key, tr]) => [
        [plain(who(key))],
        [muted(tr.intervals.length > 0 ? formatRanges(tr.intervals) : tr.unknownRead ? 'lines ?' : tr.hits > 0 ? 'search hit' : '—')],
        [plain(`${tr.reads}${tr.rereads > 0 ? ` ↩${tr.rereads}` : ''}`)],
        [plain(fmtEstTokens(tr.estTokens).replace(/ tok$/, ''))],
      ]),
    })
  }

  const internal = ctx.otherAgents ?? new Set<string>()
  blocks.push({
    kind: 'table',
    title: 'History, newest first',
    columns: [{ label: 'TIME' }, { label: 'ACTION' }, { label: 'LINES' }, { label: '≈TOKENS', right: true }, { label: 'AGENT' }],
    rows: [...f.history].reverse().map((e) => historyRow(e, internal, (id) => registry?.get(id)?.label ?? null)),
  })
  if (ctx.themeHint) blocks.push({ kind: 'note', chips: [muted(ctx.themeHint)] })
  return blocks
}

/** The usage view (`u`), as lines for the terminal. */
export function agentLines(s: SessionState): DetailLine[] {
  return blockLines(agentBlocks(s))
}

/**
 * The usage view (`u`): the session's exact API usage, then per agent its files, ≈ tokens and exact usage (the rows
 * add up to the total), then what the markers mean.
 */
export function agentBlocks(s: SessionState): Block[] {
  const blocks: Block[] = [{ kind: 'title', name: 'Usage', path: '', mark: '' }]
  if (s.usage.requests > 0) {
    blocks.push({
      kind: 'terms',
      title: 'This session, exact API usage',
      rows: [
        ...(s.latestContext !== null ? [{ term: muted('context'), meaning: [plain(fmtExactTokens(s.latestContext)), muted(' (latest request)')] }] : []),
        { term: muted('billed'), meaning: [plain(`∑ ${fmtExactTokens(s.billedSum)} incl. cache re-reads`), muted(' (never the context size)')] },
        { term: muted('out'), meaning: [plain(fmtExactTokens(s.usage.output))] },
      ],
    })
  }
  if (s.registry.size > 0) {
    const t = agentTable(s)
    const fig = (n: number) => fmtEstTokens(n).replace(/ tok$/, '')
    const exact = (n: number) => fmtExactTokens(n, { short: true })
    const rows: (readonly Chip[])[][] = []
    for (const r of t.rows) {
      const a = r.key === MAIN ? null : s.registry.get(r.key)
      const parent = a?.parentId ? ` · from ${agentLabel(s, a.parentId)}` : ''
      const when = r.status === 'done' && r.start !== null && r.end !== null ? `done in ${Math.max(0, Math.round((r.end - r.start) / 1000))}s` : r.status ?? ''
      rows.push([[plain(r.label)], [muted(String(r.files))], [plain(fig(r.estTokens))], [plain(exact(r.billed))], [plain(exact(r.usage.output))], [muted(`${when}${parent}`)]])
      if (a?.description) rows.push([[], [], [], [], [], [muted(a.description)]])
    }
    if (t.other) rows.push([[muted('other')], [], [muted(fig(t.other.estTokens))], [muted(exact(t.other.billed))], [muted(exact(t.other.usage.output))], [muted("Claude Code's own forks")]])
    rows.push([[plain('total')], [], [plain(fig(t.total.estTokens))], [plain(exact(t.total.billed))], [plain(exact(t.total.output))], []])
    blocks.push({
      kind: 'table',
      title: 'By agent',
      columns: [{ label: 'AGENT' }, { label: 'FILES', right: true }, { label: '≈READ', right: true }, { label: '=BILLED', right: true }, { label: '=OUT', right: true }, { label: '' }],
      rows,
    })
    blocks.push({ kind: 'note', chips: [muted(`attribution: ${ATTRIBUTION}`)] })
  }
  blocks.push({ kind: 'note', chips: [muted(`${ESTIMATE_MARKER} ${ESTIMATE_LEGEND} · ${EXACT_MARKER} exact (API usage, input + cache read + cache creation)`)] })
  return blocks
}

/** The help view (`g`), as lines for the terminal. */
export function helpView(_s?: SessionState, o: { palette?: 'hex' | 'theme' } = {}): DetailLine[] {
  return blockLines(helpBlocks(o))
}

/** How full each meter step of the glyph table draws, for the vector forms. */
const METER_FRACTION: Record<string, number> = { [GLYPHS.full.glyph]: 1, [METER.most.glyph]: 0.75, [METER.half.glyph]: 0.5, [METER.part.glyph]: 0.25 }

/** The help view: the keys, every glyph and meta word a row can show, the header buttons, the columns. */
export function helpBlocks(o: { palette?: 'hex' | 'theme' } = {}): Block[] {
  return [
    { kind: 'title', name: 'Help', path: '', mark: '' },
    ...helpTables(),
    {
      kind: 'terms',
      title: 'Header buttons',
      rows: HEADER_BUTTONS.map((b) => ({ term: plain(b.glyph), meaning: [muted(b.meaning)] })),
    },
    {
      kind: 'terms',
      title: 'Columns',
      rows: [
        { term: plain('gutter'), meaning: [muted("Claude's state, then a subagent badge (E Explore · G general-purpose · P Plan · C custom · + several · m main)")] },
        { term: plain('icon'), meaning: [muted('file type (Nerd Font, or ■ folder · file); name colour = git state')] },
        { term: plain('Σ'), meaning: [muted(`right column: ${ESTIMATE_MARKER}tokens (${ESTIMATE_LEGEND}) → lines read/total → date → size`)] },
        // Theme keys can't be contrast-checked; say where the colours come from.
        { term: plain('colours'), meaning: [muted(o.palette === 'theme' ? 'palette: theme — text colours follow your Claude Code theme' : "palette: hex — the viewer's own colours (palette: theme follows your Claude Code theme)")] },
      ],
    },
    { kind: 'note', chips: [muted(`${ESTIMATE_MARKER} ${ESTIMATE_LEGEND} · ${EXACT_MARKER} exact (API usage)`)] },
    // Which keys need a click in the list first.
    { kind: 'note', chips: [muted('Letters and digits work once the pane has focus (ctrl+x tab); arrows, PgUp/PgDn, Home/End and Enter need a click in the list.')] },
  ]
}

/** The header's icon buttons, as the help view lists them. */
const HEADER_BUTTONS: readonly { readonly glyph: string; readonly meaning: string }[] = [
  { glyph: '?', meaning: 'this help (key g)' },
  { glyph: '↑', meaning: 'focus the parent folder (may go above the session root)' },
  { glyph: '⌂', meaning: 'back to the session root' },
  { glyph: '↻', meaning: 'refresh git now (key r)' },
  { glyph: '◉', meaning: 'follow Claude: bright while following, dim while paused (key f)' },
  { glyph: 'Σ', meaning: 'cycle the right column' },
  { glyph: '⊟ ⊞', meaning: 'collapse every folder / back to the default view' },
]

/** The keys, every glyph of the table and every meta word a row can show, as term tables. */
function helpTables(): Block[] {
  return [
    { kind: 'terms', title: 'Keys', rows: KEY_TABLE.map((k) => ({ term: plain(k.keys), meaning: [muted(k.meaning)] })) },
    {
      kind: 'terms',
      title: 'Glyphs',
      rows: GLYPH_TABLE.map((g) => ({ term: { text: g.glyph, color: g.color, ...(g.glyph in METER_FRACTION ? { fraction: METER_FRACTION[g.glyph]! } : {}) }, glyph: true, meaning: [muted(g.meaning)] })),
    },
    { kind: 'terms', title: 'Marks and words', rows: META_WORDS.map((m) => ({ term: plain(m.text), meaning: [muted(m.meaning)] })) },
  ]
}

/** The help view's keys, glyphs and meta words, as lines. */
export function helpLines(): DetailLine[] {
  return blockLines(helpTables())
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
