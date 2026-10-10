// Row models for the three tabs: what each line shows (glyph, name, meta,
// coverage fill, lit/pending state), colors named by palette key. Pure: the
// hook hands in the session state, the project file list, git and the time.
import type { GitFile, GitLetter, GitSnapshot, NumStat } from '../git.ts'
import type { EventKind, FileState, SessionState } from '../model.ts'
import type { ColorKey, FillTone } from '../palette.ts'
import { basename, dirname } from '../paths.ts'
import { isUnder, looseRoot } from '../roots.ts'
import { coveragePercent, instructionGroups, linesRead, unverifiedMark } from '../summary.ts'
import { fmtEstTokens } from '../tokens.ts'
import { GLYPHS, TAGS, type GlyphSpec } from './glyphs.ts'
import { fmtLines } from './text.ts'

/** How long a row stays lit after an action (a few seconds). */
export const LIT_MS = 2700

/** An in-progress tag shows at least this long, so a read that settles within a frame still shows it. */
export const MIN_TAG_MS = 600

export type Tab = 'tree' | 'touched' | 'instructions'
export type SortKey = 'recent' | 'tokens' | 'coverage'

export type Lit = 'read' | 'search' | 'edit' | 'commit' | 'instruction'

/** `tag`: the in-progress tag, the only part of a row that shimmers. */
export type Chip = { readonly text: string; readonly color: ColorKey; readonly tag?: true }

export type Row = {
  /** Stable address: `f:<path>`, `d:<dir>`, `u:<dir>` (its untouched fold), `g:<group>`, `s:<skill>`, `p:<plugin>`, `n:<note>`. */
  readonly key: string
  readonly kind: 'file' | 'dir' | 'fold' | 'group' | 'skill' | 'plugin' | 'note' | 'section'
  readonly depth: number
  readonly label: string
  /** File rows: the state key (absolute path or `skill-description:<name>`). */
  readonly path: string | null
  readonly file: FileState | null
  readonly expanded?: boolean
  /** A folder open unless closed by hand (an outside section's): its key in `expanded` is `x:<path>`, meaning closed. */
  readonly openByDefault?: true
  /** 0..1 share drawn as the row's background fill; null draws none. */
  readonly coverage: number | null
  /** What tints the fill (C1): read, edited since, or committed since the last edit. Optional: read. */
  readonly fillTone?: FillTone
  /** One glyph before the name (never color alone). */
  readonly glyph: Chip | null
  readonly tone: ColorKey
  /** The name is struck through: git reports the file deleted. */
  readonly strike?: true
  readonly lit: Lit | null
  /** A collapsed folder's `lit`: when the file that lit it acted, so a fade timer can end the light. */
  readonly litAt?: number
  readonly pending: boolean
  /** The state the row's in-progress tag shimmers in: a read, edit or commit in flight; absent when settled. */
  readonly shimmer?: Lit
  /** Out of the context since a compaction that didn't re-inject it: drawn dimmed, ⊘ kept. */
  readonly dim?: boolean
  readonly meta: readonly Chip[]
  /**
   * The meta split by column, so the view can lay out marks after the name, a git column
   * and one right value. `meta` stays their concatenation (Touched and Instructions forms, older tests).
   */
  readonly cells?: Cells
}

/** A row's parts by column. */
export type Cells = {
  /** ✎ ◆ ⚡ ↩n ⟳ ⊘ ?: after the name. */
  readonly marks: readonly Chip[]
  /** `+N −N`, `new`, `del`, `ren`, `mod`. */
  readonly git: readonly Chip[]
  /** `R/T` for a file, `touched/total` files for a folder. */
  readonly lines: string | null
  /** ≈ tokens the viewpoint read; null shows nothing (a folder whose figure repeats its only touched child's). */
  readonly tokens: number | null
  /** A collapsed folder's activity glyph for the gutter. */
  readonly gutter?: Chip | null
}

export type Pending = ReadonlyMap<string, EventKind>

export type ViewContext = {
  readonly state: SessionState
  /** The project root (session cwd). */
  readonly root: string
  readonly home: string | null
  /** Absolute paths of the project's files (pruned walk). */
  readonly projectFiles: readonly string[]
  readonly git: GitSnapshot | null
  /** In-flight tool calls by path. */
  readonly pending: Pending
  readonly now: number
  /** The folder the Tree is focused on (view only); absent = the session root. May sit above it. */
  readonly focus?: string
  /** Outside roots with their touched files and the one-level listings fetched so far (fold counts). */
  readonly outside?: readonly { readonly root: string; readonly files: readonly string[]; readonly listing: readonly string[] }[]
  /**
   * Git per section: the git snapshot of an outside section's repo, by section root (null: not a repo, or not
   * fetched yet). Outside rows take their names' colours and git meta from it; `git` stays the session root's.
   */
  readonly gitOf?: (root: string) => GitSnapshot | null
  /** Folders known from one-level listings (outside roots, a focus above the root): drawn even with no file known in them. */
  readonly listedDirs?: readonly string[]
  /** Show files Claude Code loads by itself in the Tree (default), or treat them as untouched. */
  readonly loads?: 'show' | 'hide'
  /** The switcher's mode and the agents in column order; columns draw in `all` with a subagent present. */
  readonly agents?: { readonly mode: string; readonly order: readonly string[] }
}

export type TabUi = {
  readonly expanded: ReadonlySet<string>
  readonly query: string
  readonly sort: SortKey
}

// ---- shared ------------------------------------------------------------------

/** A row's path label: relative inside the project, `~/…` under home, named for descriptions and auto memory. */
export function displayPath(path: string, root: string, home: string | null): string {
  if (path.startsWith('skill-description:')) return `${path.slice('skill-description:'.length)} (description)`
  if (path.startsWith('unresolved:')) return `${path.slice('unresolved:'.length)} (directory unknown)`
  const r = root.replace(/\/+$/, '')
  if (path.startsWith(r + '/')) return path.slice(r.length + 1)
  if (/\/\.claude\/projects\/[^/]+\/memory\/MEMORY\.md$/.test(path)) return 'MEMORY.md (auto memory)'
  if (home && path.startsWith(home + '/')) return '~/' + path.slice(home.length + 1)
  return path
}

export function coverageShare(f: FileState): number | null {
  const pct = coveragePercent(f)
  if (pct !== null) return pct / 100
  return f.coverage === 'full' ? 1 : null
}

function litOf(f: FileState, now: number): Lit | null {
  if (f.lastOutcome !== 'ok' || f.lastAction === null || now - f.lastTs > LIT_MS || now < f.lastTs - 1000) return null
  switch (f.lastAction) {
    case 'read':
      return 'read'
    case 'edit':
    case 'write':
      return 'edit'
    case 'commit':
      return 'commit'
    case 'autoload':
    case 'skillLoad':
      return 'instruction'
  }
  // Search hits and listings get their glyph, never a light: a grep would light a block of rows.
  return null
}

const LIT_LABEL: Record<Lit, (f: FileState) => string> = {
  read: () => 'read',
  search: () => 'hit',
  edit: (f) => (f.lastAction === 'write' ? 'wrote' : 'edited'),
  commit: () => 'committed',
  instruction: () => 'loaded',
}

/** The in-progress tag and the state its shimmer takes, by pending kind. */
function tagOf(kind: EventKind): { text: string; lit: Lit } {
  return kind === 'commit' ? { text: TAGS.commit, lit: 'commit' } : kind === 'edit' || kind === 'write' ? { text: TAGS.edit, lit: 'edit' } : { text: TAGS.read, lit: 'read' }
}

const chip = (g: GlyphSpec): Chip => ({ text: g.glyph, color: g.color })

/** The row's state glyph: what was read, else the latest of commit and edit, else a match or a listing. */
function stateGlyph(f: FileState): Chip | null {
  switch (f.coverage) {
    case 'full':
      return chip(GLYPHS.full)
    case 'partial':
    case 'capped':
    case 'partial-unknown':
      return chip(GLYPHS.partial)
  }
  const mark = changeMark(f)
  if (mark) return mark
  if (f.coverage === 'hit') return chip(GLYPHS.match)
  if (f.listings > 0) return chip(GLYPHS.seen)
  return null
}

/** ◆ when committed since its last edit, ✎ when edited: shown as the glyph, or beside a read glyph. */
function changeMark(f: FileState): Chip | null {
  const tone = fillTone(f)
  if (tone === 'commit') return chip(GLYPHS.committed)
  if (tone === 'edit' || f.edits + f.writes > 0) return chip(GLYPHS.edited)
  return null
}

/** Seen from a viewpoint that didn't change the file: another agent edited or wrote it. */
function othersEdited(f: FileState): boolean {
  return f.edits + f.writes === 0 && [...f.byAgent.values()].some((t) => t.edits + t.writes > 0)
}

/** Git meta: `+N −N` for changed lines, then a word for what isn't a plain modification. */
function gitMeta(g: GitFile & NumStat): Chip[] {
  const out: Chip[] = []
  const counted = g.added > 0 || g.removed > 0
  if (counted) out.push({ text: `+${g.added}`, color: 'added' }, { text: `−${g.removed}`, color: 'removed' })
  const word = g.letter === '?' || g.letter === 'A' ? 'new' : g.letter === 'D' ? 'del' : g.letter === 'R' ? 'ren' : g.letter === 'M' && !counted ? 'mod' : null
  if (word) out.push({ text: word, color: GIT_KEY[g.letter] ?? 'muted' })
  return out
}

const GIT_KEY: Record<string, ColorKey> = { A: 'git.A', M: 'git.M', D: 'git.D', R: 'git.R', '?': 'git.untracked', '!': 'git.ignored' }

/** Right-side meta for a file row: tag or state word, ↩n, ⟳, ⊘, ◆/✎, git, ?, ⚡, lines read/total, ≈tokens. */
function fileMeta(f: FileState | null, path: string, glyph: Chip | null, ctx: ViewContext, opts: { lines: boolean; autoGlyph: boolean }): { meta: Chip[]; lit: Lit | null; pending: boolean; shimmer: Lit | undefined; cells: Cells } {
  const meta: Chip[] = []
  const marks: Chip[] = []
  const git: Chip[] = []
  let lines: string | null = null
  const pendingKind = ctx.pending.get(path)
  const tag = pendingKind ? tagOf(pendingKind) : null
  const lit = f ? litOf(f, ctx.now) : null
  if (lit && f && !tag) meta.push({ text: LIT_LABEL[lit](f), color: lit })
  const g = ctx.git?.files.get(path)
  if (f) {
    if (f.rereads > 0) marks.push({ text: `↩${f.rereads}`, color: 'accent' })
    if (f.reloads > 0 && !f.outOfContext) marks.push({ text: '⟳', color: 'instruction' })
    // A compaction dropped it and nothing re-injected it: history kept, out of the context now.
    if (f.outOfContext) marks.push({ text: '⊘', color: 'muted' })
    // Another agent's edit stays out of cell 0 (the viewpoint's state); `✎` beside its badge says who made it.
    const mark = changeMark(f) ?? (othersEdited(f) ? chip(GLYPHS.edited) : null)
    if (mark && mark.text !== glyph?.text) marks.push(mark)
    meta.push(...marks)
  }
  if (g && g.letter !== '!') git.push(...gitMeta(g))
  meta.push(...git)
  if (f) {
    const late: Chip[] = []
    if (unverifiedMark(f)) late.push({ text: '?', color: 'accent' })
    if (f.instruction && f.instruction.mode !== 'tool' && !opts.autoGlyph) late.push({ text: GLYPHS.auto.glyph, color: 'instruction' })
    marks.push(...late)
    meta.push(...late)
    if (opts.lines) {
      const read = linesRead(f)
      if (f.instruction?.origin === 'skillDescription') meta.push({ text: (lines = 'desc'), color: 'muted' })
      else if (read) meta.push({ text: (lines = `${fmtLines(read.read)}/${fmtLines(read.total)}`), color: 'muted' })
    }
    if (f.estTokens > 0) meta.push({ text: fmtEstTokens(f.estTokens), color: 'muted' })
    // One agent's view: a file only other agents saw says who.
    if (f.via && f.via.length > 0 && f.lastAction === null && f.instruction === null) {
      // The row's badge names who saw it; `via` stays in the meta words for the older forms.
      meta.push({ text: viaText(f.via), color: 'muted' })
    }
  }
  // The in-progress tag sits at the right edge; only it shimmers.
  if (tag) meta.push({ text: tag.text, color: 'pending', tag: true })
  return { meta, lit, pending: pendingKind !== undefined, shimmer: tag?.lit, cells: { marks, git, lines, tokens: f && f.estTokens > 0 ? f.estTokens : null } }
}

/** `via Explore#1`, or `via Explore#1+2` when more agents saw it. */
function viaText(via: readonly string[]): string {
  return `via ${via[0]}${via.length > 1 ? `+${via.length - 1}` : ''}`
}


/** The row's fill tint: the latest of an edit/write and a commit decides; otherwise read. */
export function fillTone(f: FileState): FillTone {
  for (let i = f.history.length - 1; i >= 0; i--) {
    const e = f.history[i]!
    if (e.outcome !== 'ok') continue
    if (e.kind === 'commit') return 'commit'
    if (e.kind === 'edit' || (e.kind === 'write' && e.source !== 'gitScan')) return 'edit'
  }
  return 'read'
}

/** A file's name takes its git state's colour; touched and clean is `text`, untouched `muted`. */
const GIT_TONE: Record<GitLetter, ColorKey> = { M: 'git.M', A: 'git.A', '?': 'git.A', D: 'git.D', R: 'git.R', '!': 'git.ignored' }

function fileRow(path: string, f: FileState | null, label: string, depth: number, ctx: ViewContext, glyph?: Chip | null, noAutoMark = false): Row {
  const pendingKind = ctx.pending.get(path)
  const state = glyph !== undefined ? glyph : f ? stateGlyph(f) : null
  const { meta, lit, pending, shimmer, cells } = fileMeta(f, path, state, ctx, { lines: true, autoGlyph: noAutoMark || glyph?.text === GLYPHS.auto.glyph })
  const touched = f !== null && (f.lastAction !== null || f.instruction !== null)
  // Only a file the main context held and a compaction dropped; one only a subagent read was never in it.
  const dim = f?.outOfContext != null && !pending && lit === null
  const letter = ctx.git?.files.get(path)?.letter
  const ignored = letter === '!'
  const shown = pendingKind !== undefined ? chip(GLYPHS.busy) : state
  return {
    key: `f:${path}`,
    kind: 'file',
    depth,
    label,
    path,
    file: f,
    coverage: f ? coverageShare(f) : null,
    fillTone: f ? fillTone(f) : 'read',
    glyph: (dim || ignored) && shown ? { ...shown, color: 'muted' } : shown,
    tone: pending ? 'pending' : lit ?? (dim ? 'muted' : letter ? GIT_TONE[letter] : touched ? 'text' : 'muted'),
    ...(letter === 'D' ? { strike: true as const } : {}),
    lit,
    pending,
    ...(shimmer ? { shimmer } : {}),
    ...(dim ? { dim: true } : {}),
    meta: dim ? meta.map((m) => ({ ...m, color: 'muted' as const })) : meta,
    cells: dim ? { ...cells, marks: cells.marks.map((m) => ({ ...m, color: 'muted' as const })), git: cells.git.map((m) => ({ ...m, color: 'muted' as const })) } : cells,
  }
}

// ---- Tree ----------------------------------------------------------------------

/** A collapsed folder marks the latest activity inside it with that state's glyph. */
const LIT_GLYPH: Record<Lit, string> = { read: GLYPHS.full.glyph, search: GLYPHS.match.glyph, edit: GLYPHS.edited.glyph, commit: GLYPHS.committed.glyph, instruction: GLYPHS.auto.glyph }

type Dir = { readonly path: string; readonly dirs: Map<string, Dir>; readonly files: string[] }

/**
 * Every file under the root: the walk plus touched and git paths inside it (new or deleted files). `gitPaths` false
 * (an outside section): git colours the files already there but adds none, so the section lists only the
 * folders on the way to touched files. `only` (a loose root's section, roots.ts looseRoot): just these files.
 */
export function projectTree(ctx: ViewContext, gitPaths = true, only?: readonly string[]): Dir {
  const root = ctx.root.replace(/\/+$/, '')
  const top: Dir = { path: root, dirs: new Map(), files: [] }
  const all = new Set((only ?? ctx.projectFiles).filter((p) => p.startsWith(root + '/')))
  if (!only) {
    for (const p of ctx.state.files.keys()) if (p.startsWith(root + '/')) all.add(p)
    if (gitPaths) for (const p of ctx.git?.files.keys() ?? []) if (p.startsWith(root + '/')) all.add(p)
    for (const d of ctx.listedDirs ?? []) if (d.startsWith(root + '/')) all.add(d + '/\u0000')
  }
  for (const p of all) {
    const parts = p.slice(root.length + 1).split('/')
    let d = top
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.get(part)
      if (!next) {
        next = { path: `${d.path}/${part}`, dirs: new Map(), files: [] }
        d.dirs.set(part, next)
      }
      d = next
    }
    if (!p.endsWith('/\u0000')) d.files.push(p)
  }
  dropFolderFiles(top)
  return top
}

/** A folder recorded as a file (an older log's `ls docs/adr`) shows once, as the folder. */
function dropFolderFiles(d: Dir): void {
  for (let i = d.files.length - 1; i >= 0; i--) if (d.dirs.has(basename(d.files[i]!))) d.files.splice(i, 1)
  for (const sub of d.dirs.values()) dropFolderFiles(sub)
}

/** `active`: something inside was touched in the folding sense (the folder stays out of its parent's fold). */
type Rollup = {
  total: number
  touched: number
  tokens: number
  tokenFiles: number
  lit: Lit | null
  pending: boolean
  litTs: number
  active: boolean
  /** Git changes under the folder: files changed, of them new, and lines added / removed. */
  git: { changed: number; fresh: number; added: number; removed: number }
}

/**
 * Touched for folding: read, searched, edited, committed, loaded, changed in git, or in flight.
 * A listing alone (`ls`, `find`) is not, nor is being untracked: a folder of new files nobody read folds.
 */
function touchedFile(path: string, ctx: ViewContext): boolean {
  if (ctx.pending.has(path)) return true
  if (ctx.loads === 'hide') {
    const f = ctx.state.files.get(path)
    if (f && isClaudeCodeLoad(f) && f.instruction!.mode === 'auto' && !f.history.some((e) => e.outcome === 'ok' && e.kind !== 'autoload' && e.kind !== 'listing' && e.kind !== 'compact')) return gitTouched(path, ctx)
  }
  const g = ctx.git?.files.get(path)
  if (g && g.letter !== '!' && g.letter !== '?') return true
  const f = ctx.state.files.get(path)
  if (f?.via && f.via.length > 0) return true
  return f !== undefined && (f.instruction !== null || f.history.some((e) => e.outcome === 'ok' && e.kind !== 'listing' && e.kind !== 'compact'))
}

function rollup(d: Dir, ctx: ViewContext, memo: Map<string, Rollup>): Rollup {
  const r: Rollup = { total: 0, touched: 0, tokens: 0, tokenFiles: 0, lit: null, pending: false, litTs: 0, active: false, git: { changed: 0, fresh: 0, added: 0, removed: 0 } }
  for (const sub of d.dirs.values()) {
    const s = rollup(sub, ctx, memo)
    r.total += s.total
    r.touched += s.touched
    r.tokens += s.tokens
    r.tokenFiles += s.tokenFiles
    r.git.changed += s.git.changed
    r.git.fresh += s.git.fresh
    r.git.added += s.git.added
    r.git.removed += s.git.removed
    r.pending ||= s.pending
    r.active ||= s.active
    if (s.lit && s.litTs >= r.litTs) {
      r.lit = s.lit
      r.litTs = s.litTs
    }
  }
  for (const p of d.files) {
    r.total += 1
    const f = ctx.state.files.get(p)
    if (ctx.pending.has(p)) r.pending = true
    if (touchedFile(p, ctx)) r.active = true
    const g = ctx.git?.files.get(p)
    if (g && g.letter !== '!') {
      r.git.changed += 1
      if (g.letter === '?' || g.letter === 'A') r.git.fresh += 1
      r.git.added += g.added
      r.git.removed += g.removed
    }
    if (!f) continue
    if (f.lastAction !== null || f.instruction) r.touched += 1
    r.tokens += f.estTokens
    if (f.estTokens > 0) r.tokenFiles += 1
    const lit = litOf(f, ctx.now)
    if (lit && f.lastTs >= r.litTs) {
      r.lit = lit
      r.litTs = f.lastTs
    }
  }
  memo.set(d.path, r)
  return r
}

/** Search is over paths relative to the project, never the absolute prefix. */
function matches(relative: string, query: string): boolean {
  return query === '' || relative.toLowerCase().includes(query.toLowerCase())
}

/**
 * Tree tab rows: folders first, collapsed unless expanded (or holding a search hit). In a folder holding touched
 * files, only those (and folders holding them) get rows; the untouched rest fold into one `u:` row
 * at the end. A search shows every match, folded or not.
 */
export function treeRows(ctx: ViewContext, ui: TabUi): Row[] {
  const focus = ctx.focus === undefined ? ctx.root : ctx.focus.length > 1 ? ctx.focus.replace(/\/+$/, '') : ctx.focus
  // Focused inside an outside section, the rows follow that section's rules: its repo's git, folders
  // holding touched files open as they were in the section.
  // projectFiles holds only the focused folder's own listing: the section's listings give the deeper folds.
  const sec = ctx.focus === undefined ? undefined : owning(ctx).find((o) => isUnder(focus, o.root))
  const rows = treeBody({ ...ctx, root: focus, ...(sec ? { git: ctx.gitOf?.(sec.root) ?? null, projectFiles: [...ctx.projectFiles, ...sec.listing] } : {}) }, ui, 0, sec !== undefined)
  if (focus !== ctx.root.replace(/\/+$/, '') || ui.query !== '') return rows
  if (ctx.loads !== 'hide') loadsSection(ctx, ui, rows)
  const loads = [...ctx.state.files.values()].filter(isClaudeCodeLoad)
  for (const sec of ctx.outside ?? []) outsideSection(ctx, ui, sec, loads, rows)
  return rows
}

/** Outside sections that own the folders under their root: every one but a loose root's (roots.ts looseRoot). */
function owning(ctx: ViewContext): NonNullable<ViewContext['outside']> {
  return (ctx.outside ?? []).filter((o) => !looseRoot(o.root, ctx.root, ctx.home ?? ''))
}

/**
 * One outside root as a section: a header row (repo icon, the home-shortened root, its ≈ rollup), then
 * the same rules as the project (touched rows only, untouched siblings folded), from the listings fetched so far.
 * Open by default; a click closes it (`r:<root>` kept while closed). A loose root's section (home, `/`, a folder
 * holding the session root) shows only its own files: everything else under it belongs to the session or another
 * section, or is a load.
 */
function outsideSection(ctx: ViewContext, ui: TabUi, sec: { root: string; files: readonly string[]; listing: readonly string[] }, claudeLoads: readonly FileState[], rows: Row[]): void {
  const key = `r:${sec.root}`
  const open = !ui.expanded.has(key)
  const loose = looseRoot(sec.root, ctx.root, ctx.home ?? '')
  // Claude Code loads inside the root sit in its tree, so the header counts them like its folders do.
  const loads = loose ? [] : claudeLoads.filter((f) => isUnder(f.path, sec.root) && !sec.files.includes(f.path)).map((f) => f.path)
  const files = [...sec.files, ...loads]
  const tokens = files.reduce((n, p) => n + (ctx.state.files.get(p)?.estTokens ?? 0), 0)
  rows.push({
    key,
    kind: 'section',
    depth: 0,
    label: displayPath(sec.root, '\u0000', ctx.home),
    path: sec.root,
    file: null,
    expanded: open,
    coverage: null,
    glyph: { text: open ? '▾' : '▸', color: 'muted' },
    tone: 'accent',
    lit: null,
    pending: false,
    meta: tokens > 0 ? [{ text: fmtEstTokens(tokens), color: 'muted' }] : [],
    cells: { marks: [], git: [], lines: `${files.length}`, tokens: tokens > 0 ? tokens : null },
  })
  // Its rows read git from the section's own repo, never the session's.
  if (open) rows.push(...treeBody({ ...ctx, root: sec.root, projectFiles: sec.listing, git: ctx.gitOf?.(sec.root) ?? null }, ui, 1, true, loose ? sec.files : undefined))
}

/**
 * The rows of one root's tree, starting at `depth0`. `autoOpen` (outside sections): folders holding touched files
 * start open, and a press closes them (`x:<path>` kept in `expanded` while closed); the root is resolved late, so
 * follow's reveal can't know their ancestors in advance. `only`: projectTree's.
 */
function treeBody(ctx: ViewContext, ui: TabUi, depth0: number, autoOpen = false, only?: readonly string[]): Row[] {
  const top = projectTree(ctx, !autoOpen, only)
  const memo = new Map<string, Rollup>()
  rollup(top, ctx, memo)
  const root = top.path
  const rows: Row[] = []
  const rel = (p: string) => p.slice(root.length + 1)
  const hasHit = (d: Dir): boolean => d.files.some((p) => matches(rel(p), ui.query)) || [...d.dirs.values()].some(hasHit)
  const dirRow = (sub: Dir, name: string, depth: number) => {
    const r = memo.get(sub.path)!
    const byDefault = autoOpen && r.active
    const open = ui.query !== '' || (byDefault ? !ui.expanded.has(`x:${sub.path}`) : ui.expanded.has(sub.path))
    const meta: Chip[] = []
    // A collapsed folder shows the activity inside it (dim-lit).
    const activity: Chip | null = !open && r.pending ? chip(GLYPHS.busy) : !open && r.lit ? { text: LIT_GLYPH[r.lit], color: r.lit } : null
    if (activity) meta.push(activity)
    meta.push({ text: `${r.touched}/${r.total}`, color: 'muted' })
    if (r.tokens > 0) meta.push({ text: fmtEstTokens(r.tokens), color: 'muted' })
    rows.push({
      key: `d:${sub.path}`,
      kind: 'dir',
      depth,
      label: name,
      path: sub.path,
      file: null,
      expanded: open,
      ...(byDefault ? { openByDefault: true as const } : {}),
      coverage: null,
      glyph: { text: open ? '▾' : '▸', color: 'muted' },
      // A folder holding git changes takes their colour (all new → git.A), like its files.
      tone: r.git.changed > 0 ? (r.git.fresh === r.git.changed ? 'git.A' : 'git.M') : r.touched > 0 || r.active ? 'text' : 'muted',
      lit: open ? null : r.lit,
      ...(!open && r.lit ? { litAt: r.litTs } : {}),
      pending: !open && r.pending,
      meta,
      // An open folder whose figure is just its one touched file's repeats nothing.
      cells: { marks: [], git: open ? [] : folderGit(r.git), lines: `${r.touched}/${r.total}`, tokens: r.tokens > 0 && (!open || r.tokenFiles > 1) ? r.tokens : null, gutter: activity },
    })
    if (open) walk(sub, depth + 1)
  }
  const fileRowAt = (p: string, depth: number) => rows.push(fileRow(p, ctx.state.files.get(p) ?? null, basename(p), depth, ctx))
  const walk = (d: Dir, depth: number) => {
    const dirs = [...d.dirs].sort(([a], [b]) => a.localeCompare(b)).filter(([, sub]) => !ui.query || hasHit(sub))
    const files = [...d.files].sort((a, b) => basename(a).localeCompare(basename(b))).filter((p) => matches(rel(p), ui.query))
    if (ui.query !== '' || !memo.get(d.path)!.active) {
      for (const [name, sub] of dirs) dirRow(sub, name, depth)
      for (const p of files) fileRowAt(p, depth)
      return
    }
    const quietDirs = dirs.filter(([, sub]) => !memo.get(sub.path)!.active)
    const quietFiles = files.filter((p) => !touchedFile(p, ctx))
    for (const [name, sub] of dirs) if (memo.get(sub.path)!.active) dirRow(sub, name, depth)
    for (const p of files) if (touchedFile(p, ctx)) fileRowAt(p, depth)
    if (quietDirs.length + quietFiles.length === 0) return
    const key = `u:${d.path}`
    const open = ui.expanded.has(key)
    rows.push({
      key,
      kind: 'fold',
      depth,
      label: foldLabel(quietFiles.length, quietDirs.length),
      path: null,
      file: null,
      expanded: open,
      coverage: null,
      glyph: { text: open ? '▾' : '▸', color: 'muted' },
      tone: 'muted',
      lit: null,
      pending: false,
      meta: [],
    })
    if (!open) return
    for (const [name, sub] of quietDirs) dirRow(sub, name, depth)
    for (const p of quietFiles) fileRowAt(p, depth)
  }
  walk(top, depth0)
  return rows
}

/** A collapsed folder's git meta: `+N −N` for changed lines, else `N new`; nothing when clean. */
function folderGit(g: Rollup['git']): Chip[] {
  if (g.added + g.removed > 0) return [{ text: `+${g.added}`, color: 'added' }, { text: `−${g.removed}`, color: 'removed' }]
  if (g.fresh > 0) return [{ text: `${g.fresh} new`, color: 'git.A' }]
  if (g.changed > 0) return [{ text: `${g.changed} mod`, color: 'git.M' }]
  return []
}

/** A file Claude Code put in the context by itself: CLAUDE.md, AGENTS.md, rules, memory. Never a skill. */
export function isClaudeCodeLoad(f: FileState): boolean {
  const i = f.instruction
  return i !== null && i.mode !== 'tool' && i.origin !== 'skill' && i.origin !== 'skillDescription' && i.origin !== 'plugin'
}

function gitTouched(path: string, ctx: ViewContext): boolean {
  const g = ctx.git?.files.get(path)
  return g !== undefined && g.letter !== '!' && g.letter !== '?'
}

/**
 * The **Loaded by Claude Code** section, under the project: loads outside every root
 * (`~/.claude/CLAUDE.md`, a parent folder's CLAUDE.md, auto memory); one inside an outside root sits in that
 * section's tree instead. Collapsed until opened (`s:loads`).
 */
function loadsSection(ctx: ViewContext, ui: TabUi, rows: Row[]): void {
  const roots = [ctx.root, ...owning(ctx).map((o) => o.root)]
  const outside = [...ctx.state.files.values()].filter((f) => f.path.startsWith('/') && isClaudeCodeLoad(f) && !roots.some((r) => isUnder(f.path, r)))
  if (outside.length === 0) return
  const key = 's:loads'
  const open = ui.expanded.has(key)
  const tokens = outside.reduce((n, f) => n + f.estTokens, 0)
  rows.push({
    key,
    kind: 'section',
    depth: 0,
    label: 'Loaded by Claude Code',
    path: null,
    file: null,
    expanded: open,
    coverage: null,
    glyph: { text: open ? '▾' : '▸', color: 'muted' },
    tone: 'instruction',
    lit: null,
    pending: false,
    meta: [{ text: fmtEstTokens(tokens), color: 'muted' }],
    cells: { marks: [], git: [], lines: `${outside.length}`, tokens },
  })
  if (!open) return
  outside.sort((a, b) => a.path.localeCompare(b.path))
  for (const f of outside) rows.push(fileRow(f.path, f, displayPath(f.path, ctx.root, ctx.home), 1, ctx))
}

/** `16 files, 2 folders not read`: singular for one, a zero part left out. */
function foldLabel(files: number, dirs: number): string {
  const part = (n: number, one: string) => (n === 0 ? null : `${n} ${one}${n === 1 ? '' : 's'}`)
  return [part(files, 'file'), part(dirs, 'folder')].filter(Boolean).join(', ') + ' not read'
}

/** Directories to expand so `path` shows in the Tree. */
export function ancestors(path: string, root: string): string[] {
  const r = root.replace(/\/+$/, '')
  const out: string[] = []
  for (let d = dirname(path); d.startsWith(r + '/'); d = dirname(d)) out.unshift(d)
  return out
}

// ---- Touched -------------------------------------------------------------------

/**
 * Files this session touched (read, hit, edited, loaded), most recent first unless sorted otherwise. Files outside the
 * session root go under the Tree's section labels, after the project's; the sort holds inside each
 * group. A group's header is open by default; a press closes it (`t:<root>` kept while closed).
 */
export function touchedRows(ctx: ViewContext, ui: TabUi): Row[] {
  const flat = touchedFlat(ctx, ui)
  const secs = ctx.outside ?? []
  if (secs.length === 0) return flat
  const member = new Map<string, number>()
  secs.forEach((sec, i) => sec.files.forEach((p) => member.set(p, i)))
  // Anything else under a section's root (a load) joins it, unless it is the session's or the root is loose.
  const owners = new Set(owning(ctx))
  const groupOf = (p: string) => member.get(p) ?? (isUnder(p, ctx.root) ? -1 : secs.findIndex((sec) => owners.has(sec) && isUnder(p, sec.root)))
  const groups = secs.map(() => [] as Row[])
  const out: Row[] = []
  for (const r of flat) {
    const i = r.path ? groupOf(r.path) : -1
    if (i < 0) out.push(r)
    else groups[i]!.push(r)
  }
  secs.forEach((sec, i) => {
    const rows = groups[i]!
    if (rows.length === 0) return
    const root = sec.root.replace(/\/+$/, '')
    const key = `t:${root}`
    const open = !ui.expanded.has(key)
    const tokens = rows.reduce((n, r) => n + (r.file?.estTokens ?? 0), 0)
    out.push({
      key,
      kind: 'section',
      depth: 0,
      label: displayPath(root, '\u0000', ctx.home),
      path: root,
      file: null,
      expanded: open,
      coverage: null,
      glyph: { text: open ? '▾' : '▸', color: 'muted' },
      tone: 'accent',
      lit: null,
      pending: false,
      meta: tokens > 0 ? [{ text: fmtEstTokens(tokens), color: 'muted' }] : [],
      cells: { marks: [], git: [], lines: `${rows.length}`, tokens: tokens > 0 ? tokens : null },
    })
    if (open) for (const r of rows) out.push({ ...r, depth: 1, label: r.path!.slice(root.length + 1) })
  })
  return out
}

/** The Touched list before grouping: every touched or in-flight file, sorted; outside rows read their section's git. */
function touchedFlat(ctx: ViewContext, ui: TabUi): Row[] {
  const files = [...ctx.state.files.values()].filter(
    (f) => !f.path.startsWith('skill-description:') && (f.lastAction !== null || f.instruction !== null || (f.via?.length ?? 0) > 0) && matches(displayPath(f.path, ctx.root, ctx.home), ui.query),
  )
  const pendingOnly = [...ctx.pending.keys()].filter((p) => !ctx.state.files.has(p))
  const cov = (f: FileState) => coverageShare(f) ?? 0
  files.sort((a, b) =>
    ui.sort === 'tokens' ? b.estTokens - a.estTokens || b.lastTs - a.lastTs : ui.sort === 'coverage' ? cov(a) - cov(b) || b.lastTs - a.lastTs : b.lastTs - a.lastTs,
  )
  const secs = owning(ctx)
  const at = (p: string): ViewContext => {
    const sec = secs.find((o) => isUnder(p, o.root))
    return sec ? { ...ctx, git: ctx.gitOf?.(sec.root) ?? null } : ctx
  }
  return [
    ...pendingOnly.map((p) => fileRow(p, null, displayPath(p, ctx.root, ctx.home), 0, at(p))),
    ...files.map((f) => fileRow(f.path, f, displayPath(f.path, ctx.root, ctx.home), 0, at(f.path))),
  ]
}

// ---- Instructions -------------------------------------------------------------


/**
 * Instructions tab: Auto-loaded (⚡), Skills (one sub-group per skill
 * with its description, SKILL.md and supporting files), Plugins and other
 * (one folded row per plugin; `expanded` holds `p:<plugin>` keys to open one).
 */
export function instructionRows(ctx: ViewContext, ui: TabUi): Row[] {
  const g = instructionGroups(ctx.state)
  const rows: Row[] = []
  const label = (f: FileState) => displayPath(f.path, ctx.root, ctx.home)
  // The gutter shows the meter; `⚡` sits once on the Auto-loaded header, rows don't
  // repeat it, and skills never carry it.
  const row = (f: FileState, depth: number, name = label(f)) => fileRow(f.path, f, name, depth, ctx, f ? stateGlyph(f) ?? (f.instruction ? chip(GLYPHS.full) : null) : null, true)
  const keep = (f: FileState) => matches(label(f), ui.query)
  const header = (key: string, text: string, tokens: number, color: ColorKey, extra?: string): Row => ({
    key,
    kind: 'group',
    depth: 0,
    label: text,
    path: null,
    file: null,
    coverage: null,
    glyph: null,
    tone: color,
    lit: null,
    pending: false,
    meta: [...(extra ? [{ text: extra, color: 'muted' as const }] : []), { text: fmtEstTokens(tokens), color: 'muted' }],
    cells: { marks: [], git: [], lines: extra ?? null, tokens: tokens > 0 ? tokens : null },
  })
  const sum = (fs: readonly FileState[]) => fs.reduce((n, f) => n + f.estTokens, 0)

  const auto = g.auto.filter(keep)
  if (auto.length > 0) {
    rows.push(header('g:auto', `${GLYPHS.auto.glyph} Auto-loaded`, sum(auto), 'instruction', `${auto.length}`))
    for (const f of auto) rows.push(row(f, 1))
  }
  const skills = [...g.skills].map(([name, fs]) => [name, fs.filter(keep)] as const).filter(([, fs]) => fs.length > 0)
  if (skills.length > 0) {
    rows.push(header('g:skills', 'Skills', sum(skills.flatMap(([, fs]) => fs)), 'instruction', `${skills.length}`))
    // Built-in and user skills Claude only knows by their description fold into one row (B3), like plugins.
    const folded: FileState[] = []
    for (const [name, fs] of skills.sort(([a], [b]) => a.localeCompare(b))) {
      if (fs.length === 1 && fs[0]!.instruction?.origin === 'skillDescription') {
        if (inProject(fs[0]!.instruction.resolvedPath, ctx.root)) rows.push(row(fs[0]!, 1, name))
        else folded.push(fs[0]!)
        continue
      }
      rows.push({ ...header(`s:${name}`, name, sum(fs), 'text'), kind: 'skill', depth: 1 })
      for (const f of fs) rows.push(row(f, 2, f.instruction?.origin === 'skillDescription' ? 'description' : basename(f.path)))
    }
    if (folded.length > 0) {
      const key = 'p:skill-descriptions'
      const open = ui.query !== '' || ui.expanded.has(key)
      rows.push({
        ...header(key, 'other skills', sum(folded), 'text', `${folded.length} ${folded.length === 1 ? 'description' : 'descriptions'}`),
        kind: 'plugin',
        depth: 1,
        expanded: open,
        glyph: { text: open ? '▾' : '▸', color: 'muted' },
      })
      if (open) for (const f of folded) rows.push(row(f, 2, label(f)))
    }
  }
  const plugins = new Map<string, FileState[]>()
  const other: FileState[] = []
  for (const f of g.other.filter(keep)) {
    if (f.owner?.kind === 'plugin') plugins.set(f.owner.name, [...(plugins.get(f.owner.name) ?? []), f])
    else other.push(f)
  }
  if (plugins.size > 0 || other.length > 0) {
    rows.push(header('g:other', 'Plugins and other', sum([...[...plugins.values()].flat(), ...other]), 'instruction'))
    for (const [name, fs] of [...plugins].sort(([a], [b]) => a.localeCompare(b))) {
      const open = ui.query !== '' || ui.expanded.has(`p:${name}`)
      rows.push({
        ...header(`p:${name}`, name, sum(fs), 'text', `${fs.length} ${fs.length === 1 ? 'file' : 'files'}`),
        kind: 'plugin',
        depth: 1,
        expanded: open,
        glyph: { text: open ? '▾' : '▸', color: 'muted' },
      })
      if (open) for (const f of fs) rows.push(row(f, 2, f.instruction?.origin === 'skillDescription' ? `${pluginSkillName(f.path)} (description)` : basename(f.path)))
    }
    for (const f of other) rows.push(row(f, 1))
  }
  return rows
}

/** A project skill (its SKILL.md under the project root) keeps its own row. */
function inProject(path: string | null, root: string): boolean {
  return path !== null && path.startsWith(root.replace(/\/+$/, '') + '/')
}

/** `skill-description:marketing:seo-audit` → `seo-audit`. */
function pluginSkillName(path: string): string {
  const name = path.slice('skill-description:'.length)
  return name.slice(name.indexOf(':') + 1)
}

export function rowsFor(tab: Tab, ctx: ViewContext, ui: TabUi): Row[] {
  return tab === 'tree' ? treeRows(ctx, ui) : tab === 'touched' ? touchedRows(ctx, ui) : instructionRows(ctx, ui)
}
