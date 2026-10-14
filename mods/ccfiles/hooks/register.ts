// Wiring only: events → ingest → store → persisted log, and the /ccfiles panel.
// OBSERVE ONLY: every hook on Claude Code's events returns next(e) or the
// untouched result of await next(e). The one exception is selection-as-context
// on prompt.submit, off unless the user turns it on. The panel's own
// hooks (its command, its pane, its scroll) answer only for this mod's pane.
import type { ElementTable, EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'
import { UNRESOLVED, pathsNeedingTotals, parseCommand, shellResetDir } from '../src/bash.ts'
import {
  attachmentRecords,
  contextEvents,
  bashWriteEvents,
  commitEvents,
  pendingTarget,
  instructionsLoadedEvent,
  contextPaths,
  readNeedsNewlineCheck,
  skillPromptEvent,
  toolEvents,
} from '../src/ingest.ts'
import { lineCount, parseNestedMemory } from '../src/instructions.ts'
import { MAX_LOG_CHARS, claudeDirOf, logPathFor, parseLog, serializeLog } from '../src/log.ts'
import { FLUSH_EVERY, Store, selectionLine } from '../src/store.ts'
import { GIT_COMMANDS, changedFiles, commitShaFromBash, diffNamesCommand, parseNameOnly, snapshot, type GitSnapshot } from '../src/git.ts'
import type { EventKind, FvEvent } from '../src/model.ts'
import { THEME_HINT, buildPalette, colorDepth, defaultPalette, mix, parseConfig, resolveTheme, themePalette, type ColorEnv, type Palette } from '../src/palette.ts'
import { instructionSummaryLine } from '../src/summary.ts'
import { ALL, MAIN, agentLabel, agentOrder, agentState } from '../src/agents.ts'
import { agentBlocks, detailBlocks, helpBlocks } from '../src/view/detail.ts'
import { blockLines } from '../src/view/blocks.ts'
import { drawBlocks, type BlockElements } from '../src/view/blocks-draw.ts'
import { clientSegs, lineSegments, listLines, rowSegments, shimmerBands, type ListHead, type Look } from '../src/view/draw.ts'
import { GLYPH_PX, bar as svgBar, type Vector } from '../src/view/svg.ts'
import { FC_LIST_ARGV, glyphsWithoutProbe, chooseGlyphs, hasNerdFontFile, libraryFontsDir, parseFcList, sshFromEnv, type GlyphSetting } from '../src/view/detect.ts'
import type { GlyphSet } from '../src/view/icons.ts'
import type { ValueMode } from '../src/view/values.ts'
import type { RowLine, RowsProps } from './rows.ts'
import {
  AGENTS,
  activate,
  closeDetail,
  collapse,
  expand,
  focusTarget,
  HELP,
  initialPanel,
  jumpToHits,
  listWindow,
  move,
  nextSort,
  openAgents,
  openDetail,
  openHelp,
  reveal,
  scroll,
  selectedRow,
  toggleCollapse,
  type PanelState,
} from '../src/view/panel.ts'
import { LIT_MS, MIN_TAG_MS, displayPath, isClaudeCodeLoad, rowsFor, type Row, type ViewContext } from '../src/view/rows.ts'
import { HELP_KEY } from '../src/view/glyphs.ts'
import { agentInfos, agentList, agentListNameWidth, agentListRowSegments, agentsLine, fileBadge, nextViewpoint, type AgentSeg } from '../src/view/agentsline.ts'
import { branchRow, footerBlock, gitCounts, tabStrip, tabWidth, type KeyHint, type Piece } from '../src/view/header.ts'
import { icon } from '../src/view/icons.ts'
import { folderTimes, nextValueMode } from '../src/view/values.ts'
import { basename } from '../src/paths.ts'
import { totals } from '../src/summary.ts'
import { PROJECT_MARKERS, additionalDirectories, breadcrumb, fitBreadcrumb, focusRepo, gitDirsToResolve, isUnder, parentFocus, parseRevParse, revParseArgv, sectionRepo, sections, settingsFiles, type RootContext, type Section } from '../src/roots.ts'
import { dirname, rootSpelling } from '../src/paths.ts'
import { cellWidth, fitRow, truncateMiddle, type Segment } from '../src/view/text.ts'
import { fmtEstTokens, fmtExactTokens } from '../src/tokens.ts'
import type { SessionState } from '../src/model.ts'

type $ = EngineInterface
type Rec = Record<string, unknown>

export const register: Register = (on, options) => {
  const store = new Store()
  const selectionContext = options.selectionContext === true
  const view = newView(store, options)

  on('tool.call', async ($, e, next) => {
    const target = pendingTarget(e as unknown as Rec, store.shellCwd(e.agentId ?? null) ?? store.cwd)
    if (target && e.tool_use_id) {
      // The row shows pending while the call runs (no await before next).
      store.pending.set(e.tool_use_id, { ...target, path: rootSpelling(target.path, store.cwd), ts: Date.now(), agentId: e.agentId ?? null })
      if (view.panel.follow) followTo(view, rootSpelling(target.path, store.cwd))
      redraw($, view)
    }
    // A `git commit` in flight tags the files it is committing.
    const committing = e.tool === 'Bash' && typeof e.command === 'string' && e.tool_use_id ? committingPaths(view, e.command) : []
    if (committing.length > 0 && e.tool_use_id) {
      view.committing.set(e.tool_use_id, committing)
      redraw($, view)
    }
    // When the tag went up (read, not awaited, so next(e) isn't held back): it stays at least MIN_TAG_MS.
    const tagged = (target || committing.length > 0) && e.tool_use_id ? $.clock.now().catch(() => null) : null
    const r = await next(e)
    try {
      const events = await ingestTool($, store, e as unknown as Rec, r as unknown as Rec, (p) => view.git?.files.get(p)?.letter === 'D')
      settled($, view, events, e.tool === 'Bash' || e.tool === 'Write')
      if (e.tool === 'Bash' && typeof e.command === 'string' && !(r as Rec).deny) afterBash($, view, e.command, r as unknown as Rec)
      else if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        for (const ev of events) view.gitRun.toolPaths.add(ev.path)
        void requestGit($, view, 'other')
      }
    } catch {
      // Ingestion problems never reach Claude Code.
    } finally {
      if (e.tool_use_id) await endTag($, view, e.tool_use_id, tagged)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    try {
      await ingestContext($, store, e as unknown as Rec, r as unknown as Rec)
      redraw($, view)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    try {
      if (typeof r.text === 'string') {
        const agentId = e.agentId ?? null
        const skills = e.type === 'skill_listing' ? await scanSkillFolders($, store) : null
        const nestedPath = e.type === 'nested_memory' ? parseNestedMemory(r.text)?.path : undefined
        const nestedDisk = nestedPath ? await readText($, nestedPath) : null
        for (const rec of attachmentRecords(e as unknown as Rec, r.text, {
          ts: await $.clock.now(),
          agentId,
          agentType: store.agentType(agentId),
          isInstruction: (p) => store.isInstruction(p),
          skillPath: (name) => skills?.get(name) ?? null,
          onDisk: (p) => (p === nestedPath ? nestedDisk : null),
        })) store.add(rec)
        redraw($, view)
        await maybeFlush($, store)
      }
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    try {
      store.add({ t: 'event', e: skillPromptEvent(e.skill, r.text, { ts: await $.clock.now(), agentId: null, agentType: null }) })
      redraw($, view)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.InstructionsLoaded', async ($, e, next) => {
    const r = await next(e)
    try {
      await noteTranscript($, store, e.transcript_path)
      const ev = instructionsLoadedEvent(e as unknown as Rec, await $.clock.now(), (id) => store.agentType(id))
      if (ev) store.add({ t: 'event', e: ev })
      redraw($, view)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  // A module reloaded mid-session (a --plugin-dir edit) sees no SessionStart: every prompt and turn end names the
  // transcript, so the existing log is adopted there instead of waiting for an InstructionsLoaded.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    try {
      await noteTranscript($, store, e.transcript_path)
      redraw($, view)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      await noteTranscript($, store, e.transcript_path)
      await flush($, store)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    try {
      await startSession($, store, e.source, e.transcript_path, e.cwd)
    } catch {}
    // Additional directories from the settings files, read once per session start (never throws).
    void readSettingsDirs($, view, e.cwd)
    // Ask for FileChanged on the git index and HEAD so commits and stages refresh the panel.
    // This adds file watches only; nothing Claude sees changes.
    if (!e.cwd) return r
    return { ...r, watchPaths: [...(r.watchPaths ?? []), `${e.cwd}/.git/index`, `${e.cwd}/.git/HEAD`] }
  }).catch(($, e, next) => next(e))

  on('classic.FileChanged', async ($, e, next) => {
    const r = await next(e)
    if (/\/\.git\/(index|HEAD)$/.test(e.file_path)) void requestGit($, view, 'other')
    return r
  }).catch(($, e, next) => next(e))


  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    if (e.requestId === PANE_ID && e.origin.kind === 'person') void requestGit($, view, 'other')
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStart', async ($, e, next) => {
    const r = await next(e)
    try {
      // The engine's own forks (compaction, memory) start with an empty type: not agents of ours.
      if (e.agent_id) store.add({ t: 'agent', ts: await $.clock.now(), agentId: e.agent_id, agentType: e.agent_type ?? '', ...(e.agent_type ? {} : { internal: true }) })
      redraw($, view)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const r = await next(e)
    try {
      // Internal forks end with an empty agent_type: note what they were (a compaction summary starts `<analysis>`).
      if (e.agent_id && !e.agent_type && store.agentType(e.agent_id) === null) {
        const last = (e as unknown as Rec).last_assistant_message
        store.add({ t: 'agent', ts: await $.clock.now(), agentId: e.agent_id, agentType: '', internal: true, hint: typeof last === 'string' ? last.slice(0, 40) : null })
      } else if (e.agent_id && e.agent_type) {
        // A user-visible subagent finished.
        store.add({ t: 'agent', ts: await $.clock.now(), agentId: e.agent_id, agentType: e.agent_type, stop: true })
        redraw($, view)
      }
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      const id = (r as { agentId?: unknown }).agentId
      // The spawn's task and the loop it happened in (its parent); a type SubagentStart hasn't named yet.
      if (typeof id === 'string' && e.subagentType) {
        store.add({ t: 'agent', ts: await $.clock.now(), agentId: id, agentType: store.agentType(id) ?? e.subagentType, parentId: e.parentAgentId ?? null, description: e.description })
        redraw($, view)
      }
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Marks where this request's tool events start in the log (no await before next).
    store.add({ t: 'step', ts: Date.now(), agentId: e.agentId ?? null })
    const result = yield* next(e)
    try {
      if (result.usage) {
        const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model } = result.usage
        store.add({
          t: 'usage',
          ts: await $.clock.now(),
          agentId: e.agentId ?? null,
          model,
          usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
          tools: result.toolUses.length,
        })
        redraw($, view)
      }
    } catch {}
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      await flush($, store)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PreCompact', async ($, e, next) => {
    const r = await next(e)
    try {
      await flush($, store)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e, next) => {
    const r = await next(e)
    try {
      await flush($, store)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      await flush($, store)
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    void requestGit($, view, 'other')
    // The only place this mod changes what Claude receives: one line, opt-in.
    if (!selectionContext || store.selection === null) return next(e)
    return next({ ...e, context: [...(e.context ?? []), selectionLine(store.selection, store.cwd)] })
  }).catch(($, e, next) => next(e))

  // ---- the /ccfiles panel -------------------------------------------------------

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'ccfiles', description: 'ccfiles: files Claude read, searched, edited; instruction files; ≈ tokens', immediate: true })
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ccfiles' }, async ($, e) => {
    // On a terminal a docked pane needs the fullscreen layout and ≥110 columns; never opens on its own.
    // Desktop runs Claude Code with no terminal: `presentation` then describes none, and the app places the pane.
    const onTerminal = (await $.session.surfaces().catch((): readonly string[] => [])).includes('terminal')
    const why = onTerminal ? openRefusal(e.presentation) : null
    if (why) return { text: why }
    const r = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
    view.open = true
    void requestGit($, view, 'other')
    return { text: r.isPlaced ? 'panel open: 1 Tree · 2 Touched · 3 Instructions (keys: j/k move, h/l fold, d detail, s filter, g help, f follow)' : `panel not placed${r.reason ? ` (${r.reason})` : ''}` }
  })

  // A folder added with /add-dir roots the outside files under it (Claude Code fires this event for /add-dir).
  on('classic.DirectoryAdded', async ($, e, next) => {
    const r = await next(e)
    if (e.directory && !view.roots.added.includes(e.directory)) view.roots.added.push(e.directory)
    redraw($, view)
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    view.open = true
    return drawPane($, view, e)
  })

  on('ui.scroll', async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.component !== 'Pane') return next(e)
    // The pane draws its own window under a fixed header: move it, don't let the engine.
    scroll(view.panel, e.by, view.list.total, view.list.height, e.origin.kind === 'person')
    redraw($, view)
    return {}
  }).catch(($, e, next) => next(e))

  // The rows Client posts here (R1). Only this pane's own element is answered; anything else passes through.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.element !== 'rows') return next(e)
    await rowsMessage($, view, e.data, e.surface)
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE_ID && !(r && typeof r === 'object' && 'deny' in r && r.deny)) {
      view.open = false
      stopTicker(view)
    }
    return r
  }).catch(($, e, next) => next(e))
}

// ---- panel ------------------------------------------------------------------------

export const PANE_ID = 'ccfiles'
/** Two presses on one folder row within this many ms focus it. */
const DOUBLE_MS = 450
const PANE_TITLE = 'ccfiles'
const GIT_THROTTLE_MS = 2000
const DEFAULT_PRUNED = ['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'target', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', 'vendor']
/** Stop walking the project past this many files (big repos). */
const MAX_WALK = 20_000

type View = {
  readonly store: Store
  readonly panel: PanelState
  open: boolean
  readonly pruned: ReadonlySet<string>
  readonly palettePath: string | null
  projectFiles: string[]
  /** The project walk: when it last started, whether files changed since, and a walk still in progress. */
  walk: { at: number; dirty: boolean; pending: { queue: string[]; files: string[] } | null }
  git: GitSnapshot | null
  /** Git refresh bookkeeping: throttle, a trailing run, and what the next run should attribute. */
  gitRun: {
    last: number
    timer: { cancel: () => void } | null
    running: boolean
    /** A request arrived during a run: run once more after it. */
    rerun: boolean
    bash: boolean
    expectCommit: boolean
    /** Files Edit/Write/NotebookEdit changed since the last snapshot: not Bash writes. */
    toolPaths: Set<string>
  }
  look: { palette: Palette; hint: string | null; checkedAt: number; mtime: number | null; text: string | null; warned: string | null }
  ticker: { cancel: () => void } | null
  /** When the pending one-shot redraw fires (clock ms). */
  tickAt: number
  /** Files a `git commit` in flight is committing, by tool_use_id (their rows show `committing`). */
  readonly committing: Map<string, readonly string[]>
  /** The person is typing in the search field (it shows their text); after Enter it shows the active filter. */
  searchTyping: boolean
  /** The list as last drawn, for scroll clamping. */
  list: { total: number; height: number }
  /** The icon set rows draw with; `auto` resolves once (detectGlyphs), `plain` until then. */
  glyphs: { setting: GlyphSetting; set: GlyphSet; resolved: boolean }
  /** The right column's form (`Σ` cycles it). */
  value: ValueMode
  iconColor: 'muted' | 'language'
  /** Coverage as a gutter meter, or also as the row fill. */
  coverage: 'meter' | 'fill'
  /** `off` keeps a working file's name still (reduced motion). */
  motion: 'on' | 'off'
  /** The last row press, for double-click focus. */
  lastPress: { key: string; at: number } | null
  /** A reload's first render looked for this session's log once (recoverLog). */
  recovered: boolean
  /** `palette: hex | theme`. */
  paletteMode: 'hex' | 'theme'
  /** `claudeCodeLoads: show | hide`. */
  loads: 'show' | 'hide'
  /**
   * Outside roots. Added directories, cached `git rev-parse` answers per directory (null = not a repo),
   * cached project-marker answers, and one-level listings of outside folders (fold counts), each fetched lazily
   * after a render, never before a hook's `next(e)`.
   */
  roots: { added: string[]; git: Map<string, string | null>; gitTries: Map<string, number>; markers: Map<string, boolean>; listings: Map<string, string[]>; busy: boolean; settingsRead: boolean }
  /** Git per section: each outside repo's snapshot by its top level, refreshed only while wanted (wantedRepos). */
  readonly repos: Map<string, RepoGit>
  /** Size and modified time per walked path (files and folders), for the date and size columns. */
  info: Map<string, { size: number; mtimeMs: number }>
}

function newView(store: Store, options: Record<string, unknown>): View {
  const pruned = typeof options.prunedDirs === 'string' && options.prunedDirs.trim() !== '' ? options.prunedDirs.split(',').map((d) => d.trim()).filter(Boolean) : DEFAULT_PRUNED
  return {
    store,
    panel: initialPanel(),
    open: false,
    pruned: new Set(pruned),
    palettePath: typeof options.palettePath === 'string' && options.palettePath.trim() !== '' ? options.palettePath.trim() : null,
    projectFiles: [],
    walk: { at: -Infinity, dirty: true, pending: null },
    git: null,
    gitRun: { last: -Infinity, timer: null, running: false, rerun: false, bash: false, expectCommit: false, toolPaths: new Set() },
    look: { palette: defaultPalette('dark'), hint: THEME_HINT, checkedAt: -Infinity, mtime: null, text: null, warned: null },
    ticker: null,
    tickAt: 0,
    committing: new Map(),
    searchTyping: false,
    list: { total: 0, height: 0 },
    glyphs: { setting: options.glyphs === 'nerd' || options.glyphs === 'plain' ? options.glyphs : 'auto', set: options.glyphs === 'nerd' ? 'nerd' : 'plain', resolved: options.glyphs === 'nerd' || options.glyphs === 'plain' },
    value: 'tokens',
    iconColor: options.iconColor === 'muted' ? 'muted' : 'language',
    coverage: options.coverage === 'fill' ? 'fill' : 'meter',
    motion: options.motion === 'off' ? 'off' : 'on',
    loads: options.claudeCodeLoads === 'hide' ? 'hide' : 'show',
    paletteMode: options.palette === 'theme' ? 'theme' : 'hex',
    recovered: false,
    lastPress: null,
    info: new Map(),
    roots: { added: [], git: new Map(), gitTries: new Map(), markers: new Map(), listings: new Map(), busy: false, settingsRead: false },
    repos: new Map(),
  }
}

/**
 * `glyphs: auto`: decided once, after a hook's `next(e)` or on the first render. Surface, SSH and
 * TERM_PROGRAM first; then one local `fc-list` run and a `~/Library/Fonts` listing (no network).
 */
async function detectGlyphs($: $, view: View, surface: string): Promise<void> {
  const g = view.glyphs
  if (g.resolved) return
  g.resolved = true
  const before = g.set
  try {
    const [termProgram, sshConnection, sshTty] = await Promise.all([
      $.env.get('TERM_PROGRAM').catch(() => undefined),
      $.env.get('SSH_CONNECTION').catch(() => undefined),
      $.env.get('SSH_TTY').catch(() => undefined),
    ])
    const base = { setting: g.setting, surface, ssh: sshFromEnv({ SSH_CONNECTION: sshConnection, SSH_TTY: sshTty }), ...(termProgram ? { termProgram } : {}) }
    const known = glyphsWithoutProbe(base)
    if (known !== null) g.set = known
    else {
      const fc = await $.process.run(FC_LIST_ARGV, { timeoutMs: 3000 }).then((r) => parseFcList(r.stdout, r.exitCode), () => null)
      const home = view.store.home
      const fonts = fc === true || !home ? null : await $.fs.list(libraryFontsDir(home)).then((xs) => hasNerdFontFile(xs.map((x) => x.name)), () => null)
      g.set = chooseGlyphs({ ...base, fcListHasGlyph: fc, libraryFontsHasNerd: fonts })
    }
    // Rows already draw `plain`: redraw only when the set changed (an extra render walks the project again).
    if (g.set !== before) redraw($, view)
  } catch {}
}

/** Why `/ccfiles` can't open here, with the fix; null when it can. */
export function openRefusal(p: { isFullscreen: boolean; columns: number }): string | null {
  if (!p.isFullscreen) return 'ccfiles needs the fullscreen layout to dock beside the transcript. Run /tui fullscreen, then /ccfiles.'
  if (p.columns < 110) return `ccfiles needs a terminal at least 110 columns wide (this one is ${p.columns}). Widen it to ≥110 columns, then run /ccfiles.`
  return null
}

function redraw($: $, view: View): void {
  if (!view.open) return
  try {
    $.ui.invalidate('ui.render')
  } catch {}
}

/** Follow: open the folders above a file Claude is touching. */
function followTo(view: View, path: string): void {
  const root = view.store.cwd
  if (root && path.startsWith(root + '/')) reveal(view.panel, path, root)
}

/** After a tool call settled: reveal what it touched (capped like a burst of hits), mark the project for a re-walk. */
function settled($: $, view: View, events: readonly FvEvent[], mayWrite: boolean): void {
  if (mayWrite) view.walk.dirty = true
  if (view.panel.follow) {
    let hits = 0
    for (const ev of events) {
      if (ev.outcome !== 'ok') continue
      if (ev.kind === 'hit' || ev.kind === 'listing') {
        if (++hits > 20) continue
      }
      followTo(view, rootSpelling(ev.path, view.store.cwd))
    }
  }
  redraw($, view)
}

/** What a Bash `git commit` will commit, from the last status scan: the staged files, or with -a every tracked change. */
function committingPaths(view: View, command: string): string[] {
  if (!view.git || !parseCommand(command, view.store.cwd ?? '/').git.includes('commit')) return []
  const files = [...view.git.files.values()]
  const staged = files.filter((f) => f.staged).map((f) => f.path)
  if (staged.length > 0 || !/\scommit\b.*\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(command)) return staged
  return files.filter((f) => f.letter !== '?' && f.letter !== '!').map((f) => f.path)
}

/** After a Bash call: its writes show up in the next status scan; a commit verb arms commit lighting. */
function afterBash($: $, view: View, command: string, r: Rec): void {
  const result = (r.result ?? {}) as Rec
  const stdout = typeof result.stdout === 'string' ? result.stdout : typeof r.text === 'string' ? r.text : ''
  // A commit that failed (nothing to commit, no identity) must not arm commit lighting.
  const commit = r.isError !== true && (parseCommand(command, view.store.cwd ?? '/').git.includes('commit') || commitShaFromBash(r, stdout) !== null)
  void requestGit($, view, commit ? 'commit' : 'bash')
}

/** D1: a git refresh at most every 2 s; a request inside the window runs once at its end. */
async function requestGit($: $, view: View, why: 'bash' | 'commit' | 'other'): Promise<void> {
  const g = view.gitRun
  if (why !== 'other') g.bash = true
  if (why === 'commit') g.expectCommit = true
  try {
    const now = await $.clock.now()
    // The open or focused outside repos refresh on the same triggers (after the await: never ahead of a hook's
    // next(e)), each on its own 2 s throttle.
    requestRepos($, view, false)
    if (g.running) {
      g.rerun = true
      return
    }
    if (g.timer) return
    const wait = GIT_THROTTLE_MS - (now - g.last)
    if (wait <= 0) return await runGit($, view)
    g.timer = $.clock.after(wait, () => {
      g.timer = null
      void runGit($, view)
    })
  } catch {
    // Runs in the background of a hook: a failure (the session ending) is dropped.
  }
}

/** Never rejects: it runs in the background. */
async function runGit($: $, view: View): Promise<void> {
  const g = view.gitRun
  g.running = true
  const bash = g.bash
  g.bash = false
  try {
    const root = view.store.cwd ?? (view.store.cwd = await $.session.root())
  if (view.store.logPath === null && !view.recovered) void recoverLog($, view, root)
    g.last = await $.clock.now()
    const run = async (argv: readonly string[]) => {
      try {
        const r = await $.process.run(argv, { cwd: root, timeoutMs: 5000 })
        return r.exitCode === 0 ? r.stdout : null
      } catch {
        return null
      }
    }
    const top = await run(GIT_COMMANDS.root)
    if (top === null) {
      view.git = null
      return
    }
    const [status, numstat, aheadBehind, branch, head, upstream] = await Promise.all([GIT_COMMANDS.status, GIT_COMMANDS.numstat, GIT_COMMANDS.aheadBehind, GIT_COMMANDS.branch, GIT_COMMANDS.head, GIT_COMMANDS.upstream].map(run))
    const next = snapshot({ root: top, status: status ?? '', numstat: numstat ?? '', aheadBehind: aheadBehind ?? '', branch: branch ?? '', head: head ?? '', upstream: upstream ?? '' })
    const prev = view.git
    const ts = await $.clock.now()
    const agent = { ts, agentId: null, agentType: null }
    const events: FvEvent[] = []
    const toolPaths = g.toolPaths
    g.toolPaths = new Set()
    if (bash && prev) {
      // What changed since the last snapshot, less the tools' own edits and staging alone (?? → A).
      const changed = changedFiles(prev, next).filter((f) => !toolPaths.has(f.path) && !(prev.files.get(f.path)?.letter === '?' && f.letter === 'A'))
      events.push(...bashWriteEvents(changed, (p) => prev.files.get(p), agent))
    }
    // D2: a commit verb, then HEAD moved: light what the commit(s) touched. The commit has
    // landed by the time this run starts, so the arming lasts one run.
    const expectCommit = g.expectCommit
    g.expectCommit = false
    if (expectCommit && prev?.head && next.head && prev.head !== next.head) {
      const names = await run(diffNamesCommand(prev.head, next.head))
      events.push(...commitEvents(parseNameOnly(names ?? '', next.root), next.head, agent))
    }
    for (const ev of events) view.store.add({ t: 'event', e: ev })
    settled($, view, events, events.length > 0)
    view.git = next
    redraw($, view)
  } catch {
  } finally {
    g.running = false
    if (g.rerun) {
      g.rerun = false
      void requestGit($, view, 'other')
    }
  }
}

/** The call settled: its tag goes now, or once it has shown MIN_TAG_MS, so fast and parallel reads show it. */
async function endTag($: $, view: View, id: string, tagged: Promise<number | null> | null): Promise<void> {
  const end = () => {
    if (view.store.pending.delete(id) || view.committing.delete(id)) redraw($, view)
  }
  try {
    const start = await tagged
    const left = start === null ? 0 : start + MIN_TAG_MS - (await $.clock.now())
    if (left > 0) $.clock.after(left, end)
    else end()
  } catch {
    end()
  }
}

function stopTicker(view: View): void {
  view.ticker?.cancel()
  view.ticker = null
}

/** The switcher's mode, back to `all` when its agent is gone (a cleared session). */
function agentMode(view: View): string {
  const s = view.store.state
  // With no subagent, everything is main's anyway: the whole session.
  if (s.registry.size === 0) return ALL
  if (view.panel.agent !== MAIN && !agentOrder(s).includes(view.panel.agent)) view.panel.agent = MAIN
  return view.panel.agent
}

/** One agent's projected session, kept until a record arrives or the mode changes (several reads per redraw). */
const projected = new WeakMap<View, { state: SessionState; records: number; mode: string; view: SessionState }>()

/** The session as the lists show it: everything (`all`), or one agent's share. */
function viewState(view: View): SessionState {
  const mode = agentMode(view)
  const s = view.store.state
  if (mode === ALL) return s
  const hit = projected.get(view)
  if (hit && hit.state === s && hit.records === view.store.records.length && hit.mode === mode) return hit.view
  const out = agentState(s, mode)
  projected.set(view, { state: s, records: view.store.records.length, mode, view: out })
  return out
}

function viewContext(view: View, now: number): ViewContext {
  const pending = new Map<string, EventKind>()
  for (const paths of view.committing.values()) for (const p of paths) pending.set(p, 'commit')
  // One agent's view shows only that agent's calls in flight.
  const mode = agentMode(view)
  for (const p of view.store.pending.values()) if (mode === ALL || (p.agentId ?? MAIN) === mode) pending.set(p.path, p.kind)
  return {
    state: viewState(view),
    agents: { mode: agentMode(view), order: agentOrder(view.store.state) },
    root: view.store.cwd ?? '/',
    home: view.store.home,
    git: view.git,
    pending,
    now,
    loads: view.loads,
    ...outsideContext(view),
  }
}

/** Git per section: one outside repo's snapshot and its own throttle, like `gitRun`. */
type RepoGit = { snap: GitSnapshot | null; last: number; timer: { cancel: () => void } | null; running: boolean; rerun: boolean }

/** The outside sections the Tree draws, from what the roots cache knows so far. */
function outsideSecs(view: View): Section[] {
  return sections(outsidePaths(view), rootContext(view)).slice(1)
}

/** The outside repo the Tree's focus sits in; null with no focus, inside the session root or its repo, or in no repo (yet). */
function focusedRepo(view: View, secs: readonly Section[]): string | null {
  const focus = view.panel.focus
  const root = view.store.cwd ?? '/'
  if (!focus || isUnder(focus, root)) return null
  const top = focusRepo(focus, secs, (d) => view.roots.git.get(d))
  return typeof top === 'string' && !isUnder(root, top) ? top : null
}

/**
 * The outside repos worth a `git status` now: those of sections open in the Tree (or open in the
 * Touched tab while it shows), and the focused folder's. None while the panel is closed.
 */
function wantedRepos(view: View): Set<string> {
  const out = new Set<string>()
  if (!view.open) return out
  const p = view.panel
  const secs = outsideSecs(view)
  for (const sec of secs) {
    const top = sectionRepo(sec, (d) => view.roots.git.get(d))
    if (typeof top !== 'string') continue
    if (!p.expanded.has(`r:${sec.root}`) || (p.tab === 'touched' && !p.expanded.has(`t:${sec.root}`))) out.add(top)
  }
  const focused = focusedRepo(view, secs)
  if (focused) out.add(focused)
  return out
}

/** The branch row's repo: the session's, the focused outside repo's, or none (focus above every repo). */
function branchGit(view: View): GitSnapshot | null {
  const focus = view.panel.focus
  const root = view.store.cwd ?? '/'
  if (!focus || isUnder(focus, root)) return view.git
  const top = focusRepo(focus, outsideSecs(view), (d) => view.roots.git.get(d))
  if (typeof top !== 'string') return null
  // Above the session root but still in its repo (a package of a monorepo): the session's snapshot.
  if (isUnder(root, top)) return view.git
  return view.repos.get(top)?.snap ?? null
}

/** Asks for a refresh of every wanted outside repo; `fresh` only for those never fetched (a render). Never throws. */
function requestRepos($: $, view: View, fresh: boolean): void {
  try {
    for (const top of wantedRepos(view)) if (!fresh || !view.repos.has(top)) void requestRepo($, view, top)
  } catch {}
}

/** One outside repo's refresh at most every 2 s; a request inside the window runs once at its end (as requestGit). */
async function requestRepo($: $, view: View, top: string): Promise<void> {
  let g = view.repos.get(top)
  if (!g) view.repos.set(top, (g = { snap: null, last: -Infinity, timer: null, running: false, rerun: false }))
  const repo = g
  try {
    const now = await $.clock.now()
    if (repo.running) {
      repo.rerun = true
      return
    }
    if (repo.timer) return
    const wait = GIT_THROTTLE_MS - (now - repo.last)
    if (wait <= 0) return await runRepoGit($, view, top, repo)
    repo.timer = $.clock.after(wait, () => {
      repo.timer = null
      void runRepoGit($, view, top, repo)
    })
  } catch {}
}

/** Read-only status, numstat, ahead/behind, branch and HEAD for one outside repo, in that repo. Never rejects. */
async function runRepoGit($: $, view: View, top: string, g: RepoGit): Promise<void> {
  g.running = true
  try {
    // A section closed or the focus moved on while the throttle waited: skip it.
    if (!wantedRepos(view).has(top)) return
    g.last = await $.clock.now()
    const run = async (argv: readonly string[]) => {
      try {
        const r = await $.process.run(argv, { cwd: top, timeoutMs: 5000 })
        return r.exitCode === 0 ? r.stdout : null
      } catch {
        return null
      }
    }
    const [status, numstat, aheadBehind, branch, head, upstream] = await Promise.all([GIT_COMMANDS.status, GIT_COMMANDS.numstat, GIT_COMMANDS.aheadBehind, GIT_COMMANDS.branch, GIT_COMMANDS.head, GIT_COMMANDS.upstream].map(run))
    // Paths resolve against `top`, spelled the way the section is (parseRevParse), so they match the touched paths.
    g.snap = status == null ? null : snapshot({ root: top, status, numstat: numstat ?? '', aheadBehind: aheadBehind ?? '', branch: branch ?? '', head: head ?? '', upstream: upstream ?? '' })
    redraw($, view)
  } catch {
  } finally {
    g.running = false
    if (g.rerun) {
      g.rerun = false
      void requestRepo($, view, top)
    }
  }
}

/**
 * Best effort: `permissions.additionalDirectories` from the project's settings, its local settings and
 * the user's (`CLAUDE_CONFIG_DIR`, else `~/.claude`), merged into the added directories. Once per session start, or
 * on the first render after a reload. Never throws.
 */
async function readSettingsDirs($: $, view: View, cwd?: string): Promise<void> {
  view.roots.settingsRead = true
  try {
    const root = cwd || view.store.cwd || (await $.session.root())
    const [home, configDir] = await Promise.all([
      $.env.get('HOME').catch(() => undefined),
      $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
    ])
    const h = (home || view.store.home || '').replace(/\/+$/, '')
    const dir = configDir || (h ? `${h}/.claude` : null)
    let added = false
    for (const path of settingsFiles(root, dir)) {
      for (const d of additionalDirectories(await readText($, path), root, h)) {
        if (view.roots.added.includes(d)) continue
        view.roots.added.push(d)
        added = true
      }
    }
    if (added) redraw($, view)
  } catch {}
}

/** The Tree's outside sections and focus, from what the roots cache knows so far. */
function outsideContext(view: View): Pick<ViewContext, 'focus' | 'outside' | 'listedDirs' | 'projectFiles' | 'gitOf'> & { projectFiles: readonly string[] } {
  const root = (view.store.cwd ?? '/').replace(/\/+$/, '')
  const listedDirs: string[] = []
  const listed = (dir: string) => {
    const xs = view.roots.listings.get(dir)
    if (!xs) return []
    const files: string[] = []
    for (const x of xs) (x.endsWith('/') ? listedDirs : files).push(`${dir === '/' ? '' : dir}/${x.replace(/\/$/, '')}`)
    return files
  }
  const focus = view.panel.focus
  const focusFiles = focus && !isUnder(focus, root) ? listed(trimSlash(focus)) : []
  const secs = outsideSecs(view)
  const outside = secs.map((sec) => {
    const dirs = new Set<string>()
    for (const p of sec.files) for (let d = dirname(p); isUnder(d, sec.root); d = dirname(d)) {
      dirs.add(d)
      if (d === sec.root) break
    }
    return { root: sec.root, files: sec.files, listing: [...dirs].flatMap(listed) }
  })
  // Each section's rows read its own repo's snapshot (none until fetched, or when it isn't a repo).
  const repoOf = new Map<string, string>()
  for (const sec of secs) {
    const top = sectionRepo(sec, (d) => view.roots.git.get(d))
    if (typeof top === 'string') repoOf.set(sec.root, top)
  }
  const gitOf = (root: string) => {
    const top = repoOf.get(root)
    return top === undefined ? null : (view.repos.get(top)?.snap ?? null)
  }
  return { ...(focus ? { focus } : {}), outside, listedDirs, gitOf, projectFiles: focusFiles.length ? [...view.projectFiles, ...focusFiles] : view.projectFiles }
}

/** A path without its trailing slashes; `/` stays `/` (a bare `''` would list the session's cwd). */
function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p
}

/** Focus (view only): the Tree shows `dir`'s subtree; null or the session root itself clears it. */
function setFocus(panel: PanelState, dir: string | null, root: string): void {
  panel.focus = dir === null || dir.replace(/\/+$/, '') === root.replace(/\/+$/, '') ? null : dir
  panel.tab = 'tree'
  panel.offset.tree = 0
  closeDetail(panel)
}

/** Touched files outside the session root that make sections: not Claude Code loads, not under `~/.claude/`. */
function outsidePaths(view: View): string[] {
  const root = (view.store.cwd ?? '/').replace(/\/+$/, '')
  const out: string[] = []
  for (const f of viewState(view).files.values()) {
    if (!f.path.startsWith('/') || isUnder(f.path, root) || isClaudeCodeLoad(f)) continue
    if (f.lastAction === null && !(f.via?.length)) continue
    out.push(f.path)
  }
  return out
}

function rootContext(view: View): RootContext {
  return {
    sessionRoot: view.store.cwd ?? '/',
    home: view.store.home ?? '',
    addedDirs: view.roots.added,
    gitTopLevel: (d) => view.roots.git.get(d),
    hasMarker: (d) => (view.roots.listings.get(d) ?? []).some((x) => (PROJECT_MARKERS as readonly string[]).includes(x)),
  }
}

/**
 * Fills the roots cache after a render (never before a hook's `next(e)`): `git rev-parse` for outside folders not
 * asked yet, and one-level listings of the folders on the way to each outside file and of a focus above the root.
 * A few per pass; redraws when anything new arrived.
 */
async function resolveRoots($: $, view: View): Promise<void> {
  const r = view.roots
  if (r.busy) return
  r.busy = true
  let changed = false
  try {
    const ctx = rootContext(view)
    const paths = outsidePaths(view)
    // Also the repo of an added directory's section, and of a focus outside the session root (git per section).
    const extra = new Set<string>()
    const secs = outsideSecs(view)
    for (const sec of secs) if (sectionRepo(sec, (d) => r.git.get(d)) === undefined) extra.add(sec.root)
    const focus = view.panel.focus
    if (focus && !isUnder(focus, view.store.cwd ?? '/') && focusRepo(focus, secs, (d) => r.git.get(d)) === undefined) extra.add(focus.length > 1 ? focus.replace(/\/+$/, '') : focus)
    for (const dir of [...new Set([...gitDirsToResolve(paths, ctx), ...extra])].slice(0, 6)) {
      const out = await $.process.run(revParseArgv(dir), { timeoutMs: 3000 }).catch(() => null)
      // A run that never finished (timed out, couldn't start) says nothing about the folder: ask again on a later
      // pass, up to three times, before taking it as no repo.
      const tries = (r.gitTries.get(dir) ?? 0) + 1
      r.gitTries.set(dir, tries)
      if (out === null && tries < 3) continue
      r.git.set(dir, parseRevParse(dir, out))
      changed = true
    }
    const home = (view.store.home ?? '').replace(/\/+$/, '')
    const want = new Set<string>()
    for (const p of paths) for (let d = dirname(p), i = 0; d !== '/' && d !== home && i < 8; d = dirname(d), i++) want.add(d)
    if (view.panel.focus) want.add(trimSlash(view.panel.focus))
    let n = 0
    for (const dir of want) {
      if (r.listings.has(dir) || n++ >= 12) continue
      const xs = await $.fs.list(dir).catch(() => [])
      r.listings.set(dir, xs.filter((x) => x.kind === 'file' || (x.kind === 'dir' && !view.pruned.has(x.name))).map((x) => (x.kind === 'dir' ? `${x.name}/` : x.name)))
      changed = true
    }
  } catch {}
  r.busy = false
  if (changed) redraw($, view)
}

function currentRows(view: View, now: number): Row[] {
  const p = view.panel
  return rowsFor(p.tab, viewContext(view, now), { expanded: p.expanded, query: p.query, sort: p.sort })
}

/** The selected file feeds selection-as-context; folders and description rows don't. */
function syncSelection(view: View, rows: readonly Row[]): void {
  const row = selectedRow(view.panel, rows)
  view.store.selection = row?.kind === 'file' && row.path && row.path.startsWith('/') ? row.path : null
}

/** How long one render may spend walking the project before the rest continues in the background. */
const WALK_BUDGET_MS = 150

/**
 * Walks the project breadth-first (pruned dirs skipped) for at most `budgetMs`;
 * true when the walk finished. An unfinished walk keeps its queue for the next step.
 */
async function walkStep($: $, view: View, budgetMs: number): Promise<boolean> {
  const w = view.walk.pending
  if (!w) return true
  const deadline = Date.now() + budgetMs
  while (w.queue.length > 0 && w.files.length < MAX_WALK) {
    if (Date.now() > deadline) {
      // A first walk shows what it has so far.
      if (view.projectFiles.length === 0) view.projectFiles = w.files
      return false
    }
    const dir = w.queue.shift()!
    let entries: Awaited<ReturnType<$['fs']['list']>>
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const x of entries) {
      if (x.kind === 'dir') {
        if (!view.pruned.has(x.name)) w.queue.push(`${dir}/${x.name}`)
      } else if (x.kind === 'file' || x.isLink) w.files.push(`${dir}/${x.name}`)
      if (x.kind === 'file' || x.kind === 'dir') view.info.set(`${dir}/${x.name}`, { size: x.size, mtimeMs: x.mtimeMs })
    }
  }
  // A newer walk may have started meanwhile: only the current one publishes.
  if (view.walk.pending === w) {
    view.projectFiles = w.files
    folderTimes(view.info, w.files)
    view.walk.pending = null
  }
  return true
}


/** Starts or continues the walk inside a render; a big project finishes in the background and redraws. */
async function walkProject($: $, view: View, root: string, now: number): Promise<void> {
  const w = view.walk
  if (!w.pending && (w.at === -Infinity || (w.dirty && now - w.at > 3000))) {
    w.at = now
    w.dirty = false
    w.pending = { queue: [root], files: [] }
  }
  if (!w.pending || (await walkStep($, view, WALK_BUDGET_MS))) return
  void (async () => {
    try {
      while (!(await walkStep($, view, WALK_BUDGET_MS))) await $.clock.sleep(10)
      redraw($, view)
    } catch {}
  })()
}

/** Theme and the palette file, re-checked at most every 2 s so edits apply on the next render. */
async function refreshLook($: $, view: View, now: number): Promise<void> {
  if (now - view.look.checkedAt < 2000) return
  view.look.checkedAt = now
  const path = view.palettePath ?? (view.store.claudeDir ? `${view.store.claudeDir}/ccfiles.colors.json` : null)
  let text = view.look.text
  if (path) {
    let mtime: number | null = null
    try {
      const slash = path.lastIndexOf('/')
      mtime = (await $.fs.list(path.slice(0, slash) || '/')).find((x) => x.name === path.slice(slash + 1))?.mtimeMs ?? null
    } catch {}
    if (mtime === null) text = null
    else if (mtime !== view.look.mtime) {
      try {
        const v = await $.fs.read(path)
        text = typeof v === 'string' ? v : null
      } catch {
        // Unreadable now: keep the last palette and try again at the next check.
        mtime = view.look.mtime
      }
    }
    view.look.mtime = mtime
  }
  let claudeTheme: string | null = null
  try {
    const row = (await $.config.list()).find((r) => r.key === 'theme')
    claudeTheme = typeof row?.value === 'string' ? row.value : null
  } catch {}
  const cfg = parseConfig(text)
  const theme = resolveTheme(cfg.theme, claudeTheme)
  view.look.text = text
  view.look.palette = buildPalette(theme.variant, cfg, colorDepth(await colorEnv($)))
  view.look.hint = theme.hint
  const warning = cfg.warnings.join('; ')
  if (warning && warning !== view.look.warned) {
    // One warning per bad key, logged once per version of the file.
    for (const w of cfg.warnings) $.ui.log(`ccfiles palette (${path}): ${w}`)
  }
  view.look.warned = warning || null
}

/** What Claude Code picks its colour depth from; mods get no colour-depth API. Read at every look check. */
async function colorEnv($: $): Promise<ColorEnv> {
  const read = (v: Promise<string | undefined>) => v.catch(() => undefined)
  const [NO_COLOR, TERM, COLORTERM, TMUX, CLAUDE_CODE_TMUX_TRUECOLOR] = await Promise.all([
    read($.env.get('NO_COLOR')),
    read($.env.get('TERM')),
    read($.env.get('COLORTERM')),
    read($.env.get('TMUX')),
    read($.env.get('CLAUDE_CODE_TMUX_TRUECOLOR')),
  ])
  return { NO_COLOR, TERM, COLORTERM, TMUX, CLAUDE_CODE_TMUX_TRUECOLOR }
}

/** `committed a1c9e42` for the session's latest commit. */
function lastCommitNote(events: readonly FvEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const sha = events[i]!.sha
    if (events[i]!.kind === 'commit' && sha) return `committed ${sha.slice(0, 7)}`
  }
  return null
}

type El = ElementTable<'terminal'>
type PaneInput = Extract<RenderInput<'Pane'>, { surface: 'terminal' }>

async function drawPane($: $, view: View, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e) as Partial<El> & Partial<Pick<ElementTable<'desktop'>, 'Svg'>> & Pick<El, 'Box' | 'Text' | 'Button'>
  const { Box, Text, Button } = els
  const props = (e as PaneInput).props
  const width = Math.max(20, props.bodyColumns)
  const height = Math.max(4, props.scroll.bodyRows)
  const now = await $.clock.now()
  await refreshLook($, view, now)
  if (!view.glyphs.resolved) void detectGlyphs($, view, e.surface)
  if (!view.roots.settingsRead) void readSettingsDirs($, view)
  void resolveRoots($, view)
  // An outside repo that just became wanted (a section appeared or opened, a focus moved into it) is fetched once now.
  requestRepos($, view, true)
  const root = view.store.cwd ?? (view.store.cwd = await $.session.root())
  await walkProject($, view, root, now)
  // `palette: theme` paints foregrounds with theme keys; bands and fills keep the hex palette.
  const hexPal = view.look.palette
  const pal = view.paletteMode === 'theme' ? themePalette(hexPal) : hexPal
  // Dark uses the terminal's own background; light paints its own.
  const panelBg = pal.paint ? pal.background : undefined
  const panel = view.panel
  const rows = currentRows(view, now)
  syncSelection(view, rows)

  // Desktop and VS Code draw Text in a proportional font, but count a Box's width in cells: there each laid-out run
  // sits in a Box of its own cells, so columns padded for the terminal still line up.
  const grid = e.surface !== 'terminal'
  // Where Svg draws (desktop), the gutter glyphs are vectors: one size whatever font the symbols fall back to.
  const vectorGlyphs = grid && Boolean(els.Svg) && Boolean(els.Client)
  const inCells = (t: string, el: RenderElement, right = false, bg?: string) =>
    grid ? Box({ width: cellWidth(t), flexShrink: 0, height: 1, overflow: 'hidden', flexDirection: 'row', ...(right ? { justifyContent: 'flex-end' } : {}), ...(bg ? { backgroundColor: bg } : {}), children: [el] }) : el
  const text = (segs: readonly Segment[]) =>
    segs.map((s) => inCells(s.text, Text({ ...(s.fg ? { color: s.fg } : {}), ...((s.bg ?? panelBg) ? { backgroundColor: s.bg ?? panelBg } : {}), ...(s.bold ? { bold: true } : {}), ...(s.underline ? { underline: true } : {}), wrap: 'truncate', children: [s.text] }), s.right, s.bg ?? panelBg))
  const line = (key: string, segs: readonly Segment[]) => Box({ key, flexDirection: 'row', height: 1, children: text(segs) })
  /**
   * Keeps the keyboard in the pane after its own presses (B2): the ring goes to the selected row, or to a key
   * that every layout draws, so a redrawn list can't drop it and send the next hotkey to the prompt.
   */
  const keepFocus = async (t: number) => {
    await $.ui.focus({ requestId: PANE_ID, key: focusTarget(panel, currentRows(view, t), !els.Client) }).catch(() => undefined)
  }
  const act = (fn: (rows: Row[]) => void) => async () => {
    try {
      const t = await $.clock.now()
      fn(currentRows(view, t))
      syncSelection(view, currentRows(view, t))
      redraw($, view)
      await keepFocus(t)
    } catch {}
  }

  const header: RenderElement[] = []
  const state = view.store.state
  const ctext = (t: string, color: string, o: { bold?: boolean; underline?: boolean; bg?: string } = {}) =>
    Text({ color, ...(o.bold ? { bold: true } : {}), ...(o.underline ? { underline: true } : {}), ...((o.bg ?? panelBg) ? { backgroundColor: o.bg ?? panelBg } : {}), wrap: 'truncate', children: [t] })
  const pieces = (ps: readonly Piece[]) => ps.map((x) => ctext(x.text, pal.colors[x.color], { bold: x.bold }))
  // The root breadcrumb, then one-glyph plain Buttons (never `x: label`). Each icon is its own hover group, so only
  // the one under the pointer lights, and that group reveals the icon's name just below it (there is no tooltip prop).
  const iconButton = (key: string, glyph: string, name: string, onPress: () => void, o: { dim?: boolean } = {}) => {
    const scope = `ccfiles:btn:${key}`
    return Box({
      flexDirection: 'row',
      children: [
        Button({ key: `btn:${key}`, plain: true, ...(o.dim ? { dimColor: true } : {}), hover: { scope, backgroundColor: pal.colors.selection, color: pal.colors.text }, children: [Text({ color: pal.colors.muted, children: [` ${glyph} `] })], onPress }),
        Box({ position: 'absolute', top: 1, right: 0, display: 'none', hover: { scope, display: 'flex' }, backgroundColor: pal.colors.selection, paddingX: 1, children: [Text({ color: pal.colors.text, wrap: 'truncate', children: [name] })] }),
      ],
    })
  }
  const helpOpen = panel.detail === HELP
  // The breadcrumb names the focus (`acme-web-app ▸ packages`); the buttons (7 × 3 cells) keep their room.
  const crumb = fitBreadcrumb(breadcrumb(panel.focus ?? root, root, view.store.home ?? '', viewContext(view, now).outside?.map((o) => o.root) ?? []), Math.max(8, width - 22))
  header.push(
    Box({
      key: 'head',
      flexDirection: 'row',
      height: 1,
      ...(panelBg ? { backgroundColor: panelBg } : {}),
      children: [
        Box({ flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: [ctext(crumb, pal.colors.accent, { bold: true })] }),
        iconButton('help', '?', 'Help (g)', act(() => (helpOpen ? closeDetail(panel) : openHelp(panel))), { dim: !helpOpen }),
        iconButton('up', '↑', 'Parent folder', act(() => {
          const up = parentFocus(panel.focus ?? root)
          if (up !== null) setFocus(panel, up, root)
        })),
        iconButton('home', '⌂', 'Back to the session root', act(() => setFocus(panel, null, root)), { dim: panel.focus === null }),
        iconButton('refresh', '↻', 'Refresh git now (r)', () => void requestGit($, view, 'other')),
        iconButton('follow', '◉', panel.follow ? 'Following Claude (f pauses)' : 'Follow Claude (f)', act(() => { panel.follow = !panel.follow }), { dim: !panel.follow }),
        iconButton('column', 'Σ', 'Right column: tokens, lines, date, size', act(() => { view.value = nextValueMode(view.value) })),
        iconButton('collapse', panel.collapsed ? '⊞' : '⊟', panel.collapsed ? 'Back to the default view' : 'Collapse every folder', act(() => toggleCollapse(panel, changedPaths(view), root))),
      ],
    }),
  )
  // The branch row, its own line (no row outside a git repo).
  const bgit = branchGit(view)
  if (bgit) {
    // Tree and Touched total the git lines in the column under the rows' own; the branch row keeps the file counts.
    const br = branchRow(bgit, width, { branchGlyph: icon('branch', view.glyphs.set), upstream: bgit.upstream ?? null, lines: !(els.Client && panel.tab !== 'instructions' && panel.detail === null) })
    header.push(
      Box({
        key: 'branch',
        flexDirection: 'row',
        height: 1,
        ...(panelBg ? { backgroundColor: panelBg } : {}),
        children: [Box({ flexGrow: 1, flexShrink: 1, overflow: 'hidden', flexDirection: 'row', children: pieces(br.left) }), ...(br.right.length ? [ctext(' ', pal.colors.muted), ...pieces(br.right)] : [])],
      }),
    )
  }
  // The tab strip. Active: selection background, bold accent, underline; inactive in `text`. Counts on
  // Touched and Instructions. No hotkey prefixes: 1/2/3 are hidden hotkeys.
  const vs = viewState(view)
  const counts = { touched: 0, instructions: 0 }
  for (const f of vs.files.values()) {
    if (f.path.startsWith('skill-description:')) continue
    if (f.lastAction !== null || f.instruction !== null || (f.via?.length ?? 0) > 0) counts.touched++
    if (f.instruction !== null) counts.instructions++
  }
  // An open view takes the filter field's place (the filter does not apply there): its own tab, sized to what is left.
  const viewName = panel.detail === null ? null : panel.detail === HELP ? 'Help' : panel.detail === AGENTS ? 'Usage' : basename(panel.detail)
  const strip = tabStrip(counts, viewName === null ? width : width - 9, { full: panel.query ? `filter: ${panel.query}` : 'filter files (s)', glyph: 's' })
  // The tabs read as tabs: on the terminal the active one in reverse video; on desktop a segmented control (a track
  // and the active tab's fill, as Box backgrounds). An open detail, help or usage view is a tab of its own at the end,
  // active, with a × that closes it, so the strip always says where you are.
  const tabButton = (key: string, label: string, count: number | null, on: boolean, onPress: () => void) => {
    const bg = on && !vectorGlyphs ? pal.colors.accent : undefined
    const fg = on ? (vectorGlyphs ? pal.colors.text : pal.background) : pal.colors.muted
    const button = Button({
      key,
      plain: true,
      hover: { scope: `ccfiles:${key}`, ...(on ? {} : { color: pal.colors.text }) },
      onPress,
      children: [
        ctext(' ', fg, { ...(bg ? { bg } : {}) }),
        ctext(label, fg, { bold: on, ...(bg ? { bg } : {}) }),
        ...(count !== null ? [ctext(` ${count}`, on ? fg : pal.colors.muted, { ...(bg ? { bg } : {}) })] : []),
        ctext(' ', fg, { ...(bg ? { bg } : {}) }),
      ],
    })
    // Desktop: the active tab's fill leans to the accent, so it stands out from the track's grey.
    return vectorGlyphs && on ? Box({ flexDirection: 'row', backgroundColor: mix(pal.background, pal.colors.accent, 0.32), children: [button] }) : button
  }
  const tabEls = strip.tabs.map((t) => tabButton(`tab:${t.tab}`, t.label, t.count, t.tab === panel.tab && panel.detail === null, act(() => { panel.tab = t.tab; closeDetail(panel) })))
  if (viewName !== null) {
    // The tabs' cells, a space, then ` name × `: the name gives way in the middle.
    const room = width - strip.tabs.reduce((n, t) => n + tabWidth(t), 0) - 1 - 4
    tabEls.push(ctext(' ', pal.colors.muted), tabButton('tab:view', `${truncateMiddle(viewName, Math.max(1, room))} ×`, null, true, act(() => closeDetail(panel))))
  }
  {
    const search = els.Input && viewName === null
      ? els.Input({
        key: 'search',
        // The search control at the strip's right end; `s` focuses it. The field shows the person's
        // text while they type and empties after Enter; the placeholder names the active filter.
        placeholder: strip.search,
        value: view.searchTyping ? panel.query : '',
        // Typing filters the list; Enter selects the first match.
        submitLabel: 'select',
        onInput: (v) => {
          view.searchTyping = true
          panel.query = v
          panel.offset[panel.tab] = 0
          redraw($, view)
        },
        onSubmit: (v) => {
          void (async () => {
            view.searchTyping = false
            panel.query = v
            const t = await $.clock.now()
            jumpToHits(panel, currentRows(view, t), root, view.list.height)
            syncSelection(view, currentRows(view, t))
            redraw($, view)
            // Hand the keyboard back to the list (the first hit) so the next hotkeys act, not type (B1).
            await keepFocus(t)
          })().catch(() => {})
        },
      })
      : null
    header.push(
      Box({
        key: 'tabs',
        flexDirection: 'row',
        height: 1,
        ...(panelBg ? { backgroundColor: panelBg } : {}),
        children: [
          Box({ flexDirection: 'row', ...(vectorGlyphs ? { backgroundColor: mix(pal.background, pal.colors.selection, 0.45) } : {}), children: tabEls }),
          Box({ flexGrow: 1, flexShrink: 1, overflow: 'hidden', justifyContent: 'flex-end', flexDirection: 'row', children: search ? [search] : [] }),
        ],
      }),
    )
  }
  // The agents line once a subagent exists; `▸` expands it into a list of at most a third of the
  // body. A click on an agent makes it the viewpoint; on a `×N` group, opens it.
  const viewpoint = agentMode(view)
  const infos = state.registry.size > 0 ? agentInfos(state) : []
  const aline = infos.length > 0 ? agentsLine(infos, { width, viewpoint, expanded: panel.agentsOpen }) : null
  if (aline) {
    const segEl = (sg: AgentSeg, i: number, onGroup?: () => void) => {
      const color = sg.selected && (sg.role === 'name' || sg.role === 'main') ? pal.colors.accent : pal.colors[AGENT_ROLE_COLOR[sg.role]]
      const t = sg.role === 'badge'
        ? ctext(sg.text, pal.colors.text, { bold: true, bg: sg.selected ? pal.colors.accent : pal.colors.selection })
        : ctext(sg.text, color, { bold: sg.selected === true || sg.role === 'main' && viewpoint === MAIN })
      if (sg.role === 'caret') return Button({ key: `agents:caret`, plain: true, children: [t], onPress: act(() => { panel.agentsOpen = !panel.agentsOpen }) })
      if (onGroup && (sg.role === 'name' || sg.role === 'badge')) return Button({ key: `agents:g${i}`, plain: true, children: [t], onPress: act(onGroup) })
      const key = sg.key
      if (key) return Button({ key: `agents:${key}:${i}`, plain: true, children: [t], onPress: act(() => { panel.agent = key; closeDetail(panel) }) })
      return t
    }
    header.push(Box({ key: 'agents', flexDirection: 'row', height: 1, ...(panelBg ? { backgroundColor: panelBg } : {}), children: aline.map((sg, i) => inCells(sg.text, segEl(sg, i))) }))
    if (panel.agentsOpen) {
      const list = agentList(infos, { bodyHeight: Math.max(3, height - header.length - 1), scroll: panel.agentsScroll, open: panel.agentGroups, viewpoint })
      panel.agentsScroll = list.offset
      const nameCol = agentListNameWidth(list.rows)
      // The list scrolls on its own; a `▴`/`▾` row above/below steps it by a page when more agents are out of view.
      const more = (key: string, label: string, by: number) =>
        header.push(Box({ key, flexDirection: 'row', height: 1, ...(panelBg ? { backgroundColor: panelBg } : {}), children: [ctext('  ', pal.colors.muted), Button({ key: `${key}:btn`, plain: true, children: [ctext(label, pal.colors.muted)], onPress: act(() => { panel.agentsScroll = Math.max(0, panel.agentsScroll + by) }) })] }))
      const page = Math.max(1, list.cap - 1)
      if (list.above) more('agentmore:up', `▴ ${list.offset} more`, -page)
      list.rows.forEach((r, ri) => {
        const onGroup = r.kind === 'group' ? () => { if (!panel.agentGroups.delete(r.type)) panel.agentGroups.add(r.type) } : undefined
        header.push(Box({ key: `agentrow:${ri}`, flexDirection: 'row', height: 1, ...(panelBg ? { backgroundColor: panelBg } : {}), children: [inCells('  ', ctext('  ', pal.colors.muted)), ...agentListRowSegments(r, width - 2, { name: nameCol }).map((sg, i) => inCells(sg.text, segEl(sg, i, onGroup)))] }))
      })
      if (list.below) more('agentmore:down', `▾ ${list.total - list.offset - list.rows.length} more`, page)
    }
  }

  // Keys are Button hotkeys (a letter or digit while the pane has focus); arrows, PgUp/PgDn and Home/End arrive
  // as ui.scroll. One line at every width: labels shorten, then the least needed keys drop (a click on
  // the list still takes every key). `c` shows only while a filter is set, `o` only on Touched, where they act.
  type OnPress = (press: { surface: string }) => void
  const press = new Map<string, OnPress>(
    panel.detail !== null
      ? [
          ['d', (press) => void closeDetailToPrompt($, view, press.surface)],
          ['j', act(() => scroll(panel, 1, 0, 0, false))],
          ['k', act(() => scroll(panel, -1, 0, 0, false))],
          ['y', (press) => void copyPath(press).catch(() => {})],
          ['q', (press) => void closeDetailToPrompt($, view, press.surface)],
          // `g` closes the help view; from a file's detail it opens help.
          [HELP_KEY, act(() => (panel.detail === HELP ? closeDetail(panel) : openHelp(panel)))],
        ]
      : [
          ['j', act((r) => move(panel, r, 1, view.list.height))],
          ['k', act((r) => move(panel, r, -1, view.list.height))],
          ['h', act((r) => collapse(panel, r, view.list.height))],
          ['l', act((r) => expand(panel, r))],
          ['d', act((r) => { const row = selectedRow(panel, r); if (row?.kind === 'file' && row.path) openDetail(panel, row.path) })],
          ['s', () => void $.ui.focus({ requestId: PANE_ID, key: 'search' }).catch(() => {})],
          ['r', () => void requestGit($, view, 'other')],
          [HELP_KEY, act(() => openHelp(panel))],
          ['f', act(() => { panel.follow = !panel.follow })],
          ['y', (press) => void copyPath(press).catch(() => {})],
          ['o', act(() => { panel.sort = nextSort(panel.sort) })],
          ['c', act(() => { panel.query = '' })],
          ['a', act(() => { if (view.store.state.registry.size > 0) panel.agent = nextViewpoint(agentMode(view), agentOrder(view.store.state)) })],
          ['u', act(() => openAgents(panel))],
        ],
  )
  // Tabs by key in every view: hidden hotkeys, like the rest.
  for (const [i, tab] of (['tree', 'touched', 'instructions'] as const).entries()) press.set(String(i + 1), act(() => { panel.tab = tab; closeDetail(panel) }))
  async function copyPath(press: { surface: string }) {
    const t = await $.clock.now()
    const path = panel.detail ?? selectedRow(panel, currentRows(view, t))?.path ?? null
    if (path && path.startsWith('/')) await $.ui.copy({ text: path, surface: press.surface as never }).catch(() => undefined)
  }
  // The footer: whose context this is and its exact size, the share of it that came from files (a bar), and the keys
  // this view takes with the latest activity. In a subagent viewpoint both figures are that agent's.
  const vp = agentMode(view)
  const foot = footerBlock(
    {
      // The context figure is main's in the all-agents view too: there is no one context for several agents.
      who: vp === MAIN || vp === ALL ? 'main agent' : agentLabel(state, vp),
      context: footContextTokens(state, vp),
      files: totals(vs).contextTokens,
      chip: activityChip(view, root),
      keys: footerKeys(panel.detail, state.registry.size > 0),
    },
    width,
  )
  const footerHeight = foot.share === null ? 2 : 3
  const listHeight = Math.max(1, height - header.length - footerHeight)
  view.list = { total: rows.length, height: listHeight }

  const body: RenderElement[] = []
  /** Glyph texts the list draws (the legend explains them). */
  const onScreen: string[] = []
  let byClient = false
  const detail = panel.detail !== null ? viewState(view).files.get(panel.detail) : undefined
  const detailBlocksNow =
    panel.detail === HELP
      ? helpBlocks({ palette: view.paletteMode })
      : panel.detail === AGENTS
        ? agentBlocks(state)
      : detail
        ? detailBlocks(detail, { root, home: view.store.home, git: view.git, themeHint: view.look.hint, otherAgents: view.store.state.otherAgents.agents, session: view.store.state })
        : null
  const detailText = detailBlocksNow && !(vectorGlyphs && els.Svg) ? blockLines(detailBlocksNow, width) : null
  if (detailBlocksNow && vectorGlyphs && els.Svg) {
    // Desktop: the blocks as boxes, text and vectors, scrolled a block at a time.
    const off = Math.min(panel.detailOffset, Math.max(0, detailBlocksNow.length - 1))
    panel.detailOffset = off
    view.list = { total: detailBlocksNow.length, height: 1 }
    body.push(Box({ key: 'detail', flexDirection: 'column', height: listHeight, overflow: 'hidden', children: drawBlocks({ Box, Text, Svg: els.Svg } as BlockElements, detailBlocksNow, pal, off) }))
  } else if (detailText) {
    const lines = detailText.flatMap((l) => lineSegments(l, width, pal))
    const off = Math.min(panel.detailOffset, Math.max(0, lines.length - listHeight))
    panel.detailOffset = off
    view.list = { total: lines.length, height: listHeight }
    const shown = lines.slice(off, off + listHeight)
    if (els.Client) {
      // The same Client as the list: it stays mounted, so the keys a click gave it keep working (d, j/k, y).
      const out: RowLine[] = shown.map((l) => ({ id: '', segs: clientSegs(l) }))
      while (out.length < listHeight) out.push({ id: '', segs: [{ t: ' '.repeat(width), w: width }] })
      byClient = true
      body.push(els.Client({ key: 'rows', module: './rows.ts', props: { lines: out, hoverBg: mix(pal.background, pal.colors.selection, 0.6), ...(panelBg ? { bg: panelBg } : {}), bands: shimmerBands(hexPal), ...(grid ? { grid } : {}) } satisfies RowsProps, width, height: listHeight }))
    } else shown.forEach((l, i) => body.push(line(`detail:${off + i}`, l)))
  } else {
    if (panel.detail !== null) closeDetail(panel)
    const summary = panel.tab === 'instructions' && rows.length > 0 ? 1 : 0
    // Tree and Touched name their columns and total them above the list (the column header and totals rows).
    const bgitNow = branchGit(view)
    const gc = bgitNow ? gitCounts(bgitNow) : null
    const listHead: ListHead | null =
      els.Client && panel.tab !== 'instructions'
        ? {
          label: panel.tab === 'tree' ? `All files · ${counts.touched} touched` : `${counts.touched} ${counts.touched === 1 ? 'file' : 'files'}`,
          git: gc ? { added: gc.added, removed: gc.removed } : null,
          value: view.value === 'tokens' ? fmtEstTokens(totals(vs).contextTokens).replace(/ tok$/, '') : null,
        }
        : null
    const headRows = listHead ? 2 : 0
    const win = listWindow(panel, rows, listHeight - summary - headRows)
    view.list = { total: rows.length, height: win.height }
    let glyphTop = 0
    let glyphs: (Vector | null)[] = []
    for (const r of win.rows) onScreen.push(...(r.glyph ? [r.glyph.text] : []), ...r.meta.map((m) => m.text))
    const selected = panel.selected[panel.tab]
    const empty = rows.length > 0 ? null : panel.query ? `no paths match “${panel.query}”` : panel.tab === 'tree' ? `no files found under ${panel.focus ?? root}` : 'nothing yet: files show here as Claude touches them'
    if (els.Client) {
      // R1: the list is one Client region (hooks/rows.ts): exact-width lines, hover, click, drag-to-scroll, shimmer.
      const plain = (t: string, fg: string): RowLine => ({ id: '', segs: clientSegs(fitRow([{ text: t, fg }], [], width)) })
      const lines: RowLine[] = []
      if (summary) lines.push(plain(instructionSummaryLine(viewState(view)), pal.colors.instruction))
      {
        // The anatomy, laid out over the visible window so the git and value columns line up; the column names
        // and the totals row above it take the same columns.
        const look: Look = { glyphs: view.glyphs.set, value: view.value, now, info: (p) => view.info.get(p), iconColor: view.iconColor, coverage: view.coverage, motion: view.motion, ...agentLook(view) }
        const laid = listLines(win.rows, width, pal, look, selected ?? undefined, { ...(listHead ? { head: listHead } : {}), vectors: vectorGlyphs })
        lines.push(...laid.head)
        glyphTop = lines.length
        glyphs = laid.glyphs
        lines.push(...laid.rows)
      }
      if (win.hidden > 0) lines.push(plain(moreNote(win), pal.colors.muted))
      if (empty) lines.push(plain(empty, pal.colors.muted))
      while (lines.length < listHeight) lines.push({ id: '', segs: [{ t: ' '.repeat(width), w: width }] })
      byClient = true
      const client = els.Client({
        key: 'rows',
        module: './rows.ts',
        props: { lines: lines.slice(0, listHeight), hoverBg: mix(pal.background, pal.colors.selection, 0.6), ...(panelBg ? { bg: panelBg } : {}), bands: shimmerBands(hexPal), ...(grid ? { grid } : {}) } satisfies RowsProps,
        width,
        height: listHeight,
      })
      // Desktop: the gutter glyphs as vectors over the list's blank gutter cells, one size for every state.
      const overlay = els.Svg && glyphs.some((g) => g !== null)
        ? glyphs.flatMap((g, i) => (g && els.Svg && glyphTop + i < listHeight ? [Box({ position: 'absolute', top: glyphTop + i, left: 0, width: 2, height: 1, alignItems: 'center', justifyContent: 'center', children: [els.Svg({ source: g.source, alt: g.alt, width: GLYPH_PX, height: GLYPH_PX })] })] : []))
        : []
      body.push(overlay.length > 0 ? Box({ key: 'list', flexDirection: 'column', height: listHeight, children: [client, ...overlay] }) : client)
    } else {
      // Surfaces without Client (vscode): one Button per row.
      if (summary) body.push(line('summary', fitRow([{ text: instructionSummaryLine(viewState(view)), fg: pal.colors.instruction }], [], width)))
      const rowEl = (r: Row) =>
        Button({ key: r.key, plain: true, onPress: act(() => activate(panel, r)), children: text(rowSegments(r, width, pal, r.key === selected)) })
      for (const r of win.rows) body.push(rowEl(r))
      if (win.hidden > 0) body.push(line('more', fitRow([{ text: moreNote(win), fg: pal.colors.muted }], [], width)))
      if (empty) body.push(line('empty', fitRow([{ text: empty, fg: pal.colors.muted }], [], width)))
    }
  }
  if (!byClient) while (body.length < listHeight) body.push(line(`pad:${body.length}`, [{ text: ' '.repeat(width) }]))

  // Keys with no click: plain hotkey Buttons in a zero-width Box fire without being drawn, so no
  // visible control carries an `x:` prefix.
  const hidden = Box({
    key: 'keys',
    width: 0,
    overflow: 'hidden',
    children: [...press].map(([key, onPress]) => Button({ key: `key:${key}`, plain: true, hotkey: key, children: [Text({ children: [key] })], onPress })),
  })
  const FOOT = 'ccfiles:footer'
  const side = (key: string, l: readonly Piece[], r: readonly Piece[], extra: RenderElement[] = []) =>
    Box({
      key,
      flexDirection: 'row',
      height: 1,
      ...(panelBg ? { backgroundColor: panelBg } : {}),
      children: [Box({ flexGrow: 1, flexShrink: 1, overflow: 'hidden', flexDirection: 'row', children: pieces(l) }), ...(r.length ? [ctext(' ', pal.colors.muted), ...pieces(r)] : []), ...extra],
    })
  const shareBar = (() => {
    if (foot.share === null) return null
    const label = ` ${foot.shareLabel}`
    if (vectorGlyphs && els.Svg) {
      const v = svgBar([{ share: foot.share, color: pal.colors.read }], mix(pal.background, pal.colors.selection, 0.6))
      return Box({ key: 'foot:share', flexDirection: 'row', height: 1, alignItems: 'center', children: [Box({ flexGrow: 1, height: 1, justifyContent: 'center', flexDirection: 'column', children: [els.Svg({ source: v.source, alt: `${foot.shareLabel} came from files`, height: 6 })] }), ctext(label, pal.colors.muted)] })
    }
    const cells = Math.max(4, width - cellWidth(label))
    const on = Math.round(foot.share * cells)
    return Box({ key: 'foot:share', flexDirection: 'row', height: 1, children: [ctext('█'.repeat(on), pal.colors.read), ctext('░'.repeat(cells - on), pal.colors.selection), ctext(label, pal.colors.muted)] })
  })()
  // Hovering the context line explains its two figures.
  const explain = Box({
    position: 'absolute',
    bottom: footerHeight,
    left: 0,
    right: 0,
    display: 'none',
    hover: { scope: FOOT, display: 'flex' },
    flexDirection: 'column',
    backgroundColor: pal.colors.selection,
    paddingX: 1,
    children: [
      Text({ color: pal.colors.text, wrap: 'wrap', children: ['exact: the size of the last request this agent sent, from the API’s usage report.'] }),
      Text({ color: pal.colors.text, wrap: 'wrap', children: ['≈ from files: characters ÷ 4 of the file text this agent received; an estimate, and only the part files make up.'] }),
    ],
  })
  const footer: RenderElement[] = [
    Box({
      key: 'footer',
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'column', hover: { scope: FOOT }, children: [side('foot:top', foot.top.left, foot.top.right), ...(shareBar ? [shareBar] : [])] }),
        side('foot:keys', foot.bottom.left, foot.bottom.right, [hidden]),
        explain,
      ],
    }),
  ]

  // The rows Client animates the shimmer itself; the hooks side only needs one redraw when
  // the next lit name fades back (LIT_MS after its action), so a one-shot timer, never a repeating one.
  let fade = Infinity
  for (const r of rows) {
    if (r.lit === null) continue
    // A file row fades from its own action; a collapsed folder from the latest one inside it (review #9).
    const at = r.file ? r.file.lastTs : r.litAt
    if (at !== undefined) fade = Math.min(fade, at + LIT_MS - now)
  }
  if (fade === Infinity) stopTicker(view)
  else if (!view.ticker || view.tickAt > now + fade + 20) {
    stopTicker(view)
    view.tickAt = now + Math.max(0, fade) + 20
    view.ticker = $.clock.after(Math.max(0, fade) + 20, () => {
      view.ticker = null
      redraw($, view)
    })
  }

  // R4: the panel paints its palette's background, so a light palette over a dark terminal (or the reverse) is a
  // whole light panel, not light row fills next to text drawn for the other background.
  return Box({ flexDirection: 'column', width, ...(panelBg ? { backgroundColor: panelBg } : {}), children: [...header, ...body, ...footer] })
}

/** Badges and other agents' figures for the rows: from the whole session, seen from the viewpoint. */
function agentLook(view: View): Pick<Look, 'badge' | 'others'> {
  const s = view.store.state
  if (s.registry.size === 0) return {}
  const vp = agentMode(view)
  const working = new Map<string, string>()
  for (const p of view.store.pending.values()) working.set(p.path, p.agentId ?? MAIN)
  return {
    badge: (path) => {
      const f = s.files.get(path)
      const b = f ? fileBadge(f, s, vp) : null
      if (!b) return null
      const who = working.get(path)
      return { text: b, live: who !== undefined && who !== vp }
    },
    others: (path) => {
      const f = s.files.get(path)
      if (!f) return 0
      let n = 0
      for (const [k, t] of f.byAgent) if (k !== vp) n += t.estTokens
      return n
    },
  }
}

/** Agents-line roles → palette keys. */
const AGENT_ROLE_COLOR: Record<AgentSeg['role'], 'text' | 'muted' | 'read' | 'git.A' | 'accent'> = {
  caret: 'muted', main: 'text', sep: 'muted', gap: 'muted', badge: 'text', name: 'text', count: 'muted', custom: 'muted',
  running: 'read', done: 'git.A', files: 'muted', tokens: 'muted', description: 'muted', more: 'muted', total: 'muted',
}

/** Touched and git-changed files: what `⊞` opens the folders above. */
function changedPaths(view: View): string[] {
  const out = [...viewState(view).files.keys()].filter((p) => p.startsWith('/'))
  for (const [p, g] of view.git?.files ?? []) if (g.letter !== '!') out.push(p)
  return out
}

/** The footer's activity chip: what runs now, else the latest commit. */
function activityChip(view: View, root: string): { full: string; short: string; color: 'pending' | 'commit' } | null {
  let last: { path: string; kind: string; agentId: string | null } | null = null
  for (const p of view.store.pending.values()) last = p
  if (last) {
    const verb = last.kind === 'edit' || last.kind === 'write' ? 'editing' : last.kind === 'commit' ? 'committing' : 'reading'
    const who = last.agentId ? `${agentLabel(view.store.state, last.agentId)} ` : ''
    const name = displayPath(last.path, root, view.store.home)
    return { full: `◌ ${who}${verb} ${name}`, short: `◌ ${basename(last.path)}`, color: 'pending' }
  }
  const commit = lastCommitNote(view.store.state.events)
  return commit ? { full: `✓ ${commit}`, short: `✓ ${commit.replace(/^committed /, '')}`, color: 'commit' } : null
}

/** The footer's exact context figure (`62k`): the viewpoint agent's latest request, main's by default. */
/** The viewpoint's context size: its latest request's input, exact; main's for main and all. */
function footContextTokens(s: SessionState, viewpoint: string): number | null {
  return viewpoint === ALL || viewpoint === MAIN ? s.latestContext : (s.contextByAgent.get(viewpoint) ?? null)
}

/** The keys the footer lists for a view: the list's, or a detail, help or usage view's. */
function footerKeys(detail: string | null, subagents: boolean): KeyHint[] {
  if (detail === null) return [['j k', 'move'], ['d', 'detail'], ...(subagents ? [['a', 'agent'] as const] : []), ['s', 'filter'], [HELP_KEY, 'help']]
  if (detail === HELP || detail === AGENTS) return [['q', 'back'], ['j k', 'scroll']]
  return [['q', 'back'], ['y', 'copy path'], ['j k', 'scroll'], [HELP_KEY, 'help']]
}

/** The fixed line under a list longer than its area: rows out of view, and how many of them are active. */
function moreNote(win: { hidden: number; active: number }): string {
  return `⋮ ${win.hidden} more${win.active > 0 ? ` · ${win.active} active` : ''}`
}

/**
 * Closing the detail (d, q) gives the keyboard back to the prompt, so the next keystroke goes to the
 * composer. 2.1.295 has no call that releases the keys, and a pane re-opened without `focus` opens without them,
 * so the pane closes and opens again unfocused, its state kept here. That is the terminal's fix only: on desktop a
 * reopened pane loses the width the person gave it, and the app hands the keyboard back on its own, so the view
 * just closes. Never throws.
 */
async function closeDetailToPrompt($: $, view: View, surface: string): Promise<void> {
  try {
    closeDetail(view.panel)
    syncSelection(view, currentRows(view, await $.clock.now()))
    if (surface !== 'terminal') return redraw($, view)
    await $.ui.close({ id: PANE_ID })
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    view.open = true
    redraw($, view)
  } catch {}
}

/** A press, copy, drag or key from the rows Client. Never throws (it answers a pane-local message). */
async function rowsMessage($: $, view: View, data: unknown, surface: string): Promise<void> {
  try {
    const m = (data ?? {}) as Partial<Record<string, unknown>>
    const panel = view.panel
    const now = await $.clock.now()
    const rows = currentRows(view, now)
    const byKey = (key: string) => rows.find((r) => r.key === key)
    if (typeof m.scrollBy === 'number') {
      // Dragging the list is the person's manual scroll: it pauses follow, like the wheel.
      scroll(panel, m.scrollBy, view.list.total, view.list.height, true)
    } else if (typeof m.press === 'string') {
      const row = byKey(m.press)
      // A second press on the same folder or section within DOUBLE_MS is a double-click: undo the first
      // press's toggle and focus it. Timed here with the engine clock (the Client's drawing thread has none to rely on).
      const last = view.lastPress
      view.lastPress = row ? { key: row.key, at: now } : null
      if (row && last && last.key === row.key && now - last.at < DOUBLE_MS && (row.kind === 'dir' || row.kind === 'section') && row.path) {
        view.lastPress = null
        activate(panel, row)
        setFocus(panel, row.path, view.store.cwd ?? '/')
      } else if (row) {
        panel.selected[panel.tab] = row.key
        activate(panel, row)
        // Opening the detail view takes the rows Client (which held the keys after the click) off screen:
        // hand the keyboard to a key Button so the next hotkey reaches the pane, not the prompt.
        if (panel.detail !== null) {
          redraw($, view)
          await $.ui.focus({ requestId: PANE_ID, key: 'btn:help' }).catch(() => undefined)
        }
      }
    } else if (typeof m.copy === 'string') {
      const path = byKey(m.copy)?.path
      if (path && path.startsWith('/')) await $.ui.copy({ text: path, surface: surface as never }).catch(() => undefined)
    } else if (typeof m.key === 'string' && panel.detail !== null) {
      // Keys while the Client shows the detail view.
      if (m.key === 'd' || m.key === 'q') return await closeDetailToPrompt($, view, surface)
      else if (m.key === HELP_KEY) panel.detail === HELP ? closeDetail(panel) : openHelp(panel)
      else if (m.key === 'j' || m.key === 'down') scroll(panel, 1, 0, 0, false)
      else if (m.key === 'k' || m.key === 'up') scroll(panel, -1, 0, 0, false)
      else if (m.key === 'y' && panel.detail.startsWith('/')) await $.ui.copy({ text: panel.detail, surface: surface as never }).catch(() => undefined)
    } else if (typeof m.key === 'string') {
      const h = view.list.height
      const sel = selectedRow(panel, rows)
      switch (m.key) {
        case 'j':
        case 'down':
          move(panel, rows, 1, h)
          break
        case 'k':
        case 'up':
          move(panel, rows, -1, h)
          break
        case 'pagedown':
          move(panel, rows, Math.max(1, h - 1), h)
          break
        case 'pageup':
          move(panel, rows, -Math.max(1, h - 1), h)
          break
        case 'h':
        case 'left':
          collapse(panel, rows, h)
          break
        case 'l':
        case 'right':
          expand(panel, rows)
          break
        case 'return':
          // Enter focuses a folder or section; elsewhere it acts like a press.
          if ((sel?.kind === 'dir' || sel?.kind === 'section') && sel.path) setFocus(panel, sel.path, view.store.cwd ?? '/')
          else if (sel) activate(panel, sel)
          break
        case 'd':
          if (sel) activate(panel, sel)
          break
        case 'f':
          panel.follow = !panel.follow
          break
        case 'o':
          panel.sort = nextSort(panel.sort)
          break
        case 'c':
          panel.query = ''
          break
        case '1':
        case '2':
        case '3':
          panel.tab = (['tree', 'touched', 'instructions'] as const)[Number(m.key) - 1]!
          closeDetail(panel)
          break
        case 'y':
          if (sel?.path?.startsWith('/')) await $.ui.copy({ text: sel.path, surface: surface as never }).catch(() => undefined)
          break
        case 's':
          await $.ui.focus({ requestId: PANE_ID, key: 'search' }).catch(() => undefined)
          break
        case HELP_KEY:
          openHelp(panel)
          break
        case 'a':
          if (view.store.state.registry.size > 0) panel.agent = nextViewpoint(agentMode(view), agentOrder(view.store.state))
          break
        case 'u':
          if (view.store.state.registry.size > 0) openAgents(panel)
          break
      }
    }
    syncSelection(view, currentRows(view, now))
    redraw($, view)
  } catch {}
}

/** `deleted`: a path git reports deleted in the work tree (it keeps its row though it is gone from disk). */
async function ingestTool($: $, store: Store, e: Rec, r: Rec, deleted: (path: string) => boolean): Promise<FvEvent[]> {
  const sessionCwd = store.cwd ?? (store.cwd = await $.session.root())
  const agentId = typeof e.agentId === 'string' ? e.agentId : null
  const shell = store.shellCwd(agentId)
  const cwd = shell ?? sessionCwd

  let endsWithNewline: boolean | null = null
  const checkPath = readNeedsNewlineCheck(e, r)
  if (checkPath) endsWithNewline = await fileEndsWithNewline($, checkPath)

  const fileTotals = new Map<string, number | null>()
  if (e.tool === 'Bash' && typeof e.command === 'string' && !r.deny && !r.isError) {
    const parsed = parseCommand(e.command, cwd, store.home, shell !== null)
    // Totals the parse needs, and any read file of unknown length (so its fill and % are known).
    const reads = parsed.actions.flatMap((a) => (a.kind === 'read' ? a.files : []))
    for (const p of new Set([...pathsNeedingTotals(parsed), ...reads].slice(0, 20))) {
      fileTotals.set(p, store.totalLines(p) ?? (await fileLineCount($, p)))
    }
  }
  const events = toolEvents(e, r, {
    ts: await $.clock.now(),
    cwd,
    cwdKnown: shell !== null,
    home: store.home,
    agentId,
    agentType: store.agentType(agentId),
    endsWithNewline,
    totals: (p) => fileTotals.get(p) ?? store.totalLines(p),
  })
  const kindOf = existence($)
  const added: FvEvent[] = []
  for (const ev of events) {
    const fromOutput = ev.outcome === 'ok' && (ev.kind === 'hit' || ev.kind === 'listing')
    // A path read out of a tool's output is a row only when it is a file on disk (never a folder), or a
    // path git reports deleted. The rest (match text, diff lines, prose) is dropped.
    if (fromOutput && !ev.path.startsWith(UNRESOLVED) && (await kindOf(ev.path)) !== 'file' && !deleted(ev.path)) continue
    // A Bash read of a path that resolved to nothing on disk is a guess: show `?`.
    const guess = ev.tool.startsWith('Bash:') && ev.outcome === 'ok' && ev.kind === 'read' && ev.verified && (await kindOf(ev.path)) === null
    const final = guess ? { ...ev, verified: false } : ev
    store.add({ t: 'event', e: final })
    added.push(final)
  }
  if (e.tool === 'Bash' && typeof e.command === 'string') {
    const moved = shellAfter(e.command, r, cwd, store.home, shell === null)
    if (moved !== undefined && moved !== shell) store.add({ t: 'shell', ts: await $.clock.now(), agentId, cwd: moved })
  }
  await maybeFlush($, store)
  return added
}

/** Where the agent's shell is after a Bash call: Claude Code's reset note wins, else the command's own cd. */
function shellAfter(command: string, r: Rec, cwd: string, home: string | null, unknown: boolean): string | null | undefined {
  const result = (r.result ?? {}) as Rec
  for (const t of [r.text, result.stdout, result.stderr]) {
    const reset = typeof t === 'string' ? shellResetDir(t) : null
    if (reset) return reset
  }
  if (typeof r.deny === 'string' || r.isError === true) return undefined
  const parsed = parseCommand(command, cwd, home)
  // From an unknown directory only an absolute or home cd lands somewhere known.
  if (unknown && !parsed.cwdAnchored) return undefined
  return parsed.cwdAfter
}

/** What a path is on disk ('file', 'dir', or null when absent), by listing its directory once per call. */
function existence($: $): (path: string) => Promise<'file' | 'dir' | null> {
  const dirs = new Map<string, Promise<Map<string, 'file' | 'dir'> | null>>()
  return async (path) => {
    const i = path.lastIndexOf('/')
    const dir = i <= 0 ? '/' : path.slice(0, i)
    let names = dirs.get(dir)
    if (!names) {
      names = $.fs.list(dir).then(
        (entries) => new Map(entries.map((x) => [x.name, x.kind === 'dir' ? 'dir' : 'file'] as const)),
        () => null,
      )
      dirs.set(dir, names)
    }
    return (await names)?.get(path.slice(i + 1)) ?? null
  }
}

async function ingestContext($: $, store: Store, e: Rec, r: Rec): Promise<void> {
  const onDisk = new Map<string, string | null>()
  for (const p of contextPaths(r)) onDisk.set(p, await readText($, p))
  const afterCompact = store.afterCompact
  store.afterCompact = false
  for (const ev of contextEvents(e, r, { ts: await $.clock.now(), agentId: null, agentType: null, afterCompact, onDisk: (p) => onDisk.get(p) ?? null })) {
    store.add({ t: 'event', e: ev })
  }
  await maybeFlush($, store)
}

async function startSession($: $, store: Store, source: string, transcriptPath: string, cwd: string): Promise<void> {
  // A compact SessionStart carries the Bash shell's directory (after `cd sub`), not the project's: keep the root.
  if (cwd && (source !== 'compact' || store.cwd === null)) store.cwd = cwd
  if (source === 'compact') {
    store.add({ t: 'event', e: { ...compactMarker(), ts: await $.clock.now() } })
    store.afterCompact = true
    // Written at once: a module reload before the next flush would lose the epoch.
    await flush($, store)
    return
  }
  if (transcriptPath) store.claudeDir = claudeDirOf(transcriptPath) ?? store.claudeDir
  const path = transcriptPath ? logPathFor(transcriptPath) : null
  if (path === store.logPath) return
  // Another session takes over: save what the previous one has not written yet.
  await flush($, store)
  if (source === 'clear' || source === 'fork') store.reset()
  store.logPath = path
  if (!path || source === 'clear') return
  // startup/resume: pick up the log a previous process wrote for this session.
  await adoptLog($, store, path)
}

function compactMarker() {
  return {
    kind: 'compact' as const, path: '', source: 'session' as const, tool: 'n/a', ranges: [], linesAdded: 0, linesRemoved: 0,
    estTokens: 0, writtenTokens: 0, outcome: 'ok' as const, agentId: null, agentType: null, verified: true, ts: 0,
  }
}

/**
 * No SessionStart seen (a module reloaded mid-session, or a start that skipped it): the
 * first event naming the transcript adopts that session's log, so a flush can't overwrite it.
 */
async function noteTranscript($: $, store: Store, transcriptPath: string | undefined): Promise<void> {
  if (!transcriptPath) return
  if (store.claudeDir === null) store.claudeDir = claudeDirOf(transcriptPath)
  if (store.logPath !== null) return
  store.logPath = logPathFor(transcriptPath)
  if (store.logPath) await adoptLog($, store, store.logPath)
}

/**
 * A `--plugin-dir` reload mid-session starts with an empty store and no SessionStart: find this session's
 * transcript by its id under the config dir's project folder, and adopt its log, so the panel keeps its data
 * through a reload instead of waiting for the next hook that names the transcript. Only a transcript that exists
 * is taken (a wrong guess must not redirect where the log is written). Never throws.
 */
async function recoverLog($: $, view: View, root: string): Promise<void> {
  view.recovered = true
  try {
    const [home, configDir, id] = await Promise.all([
      $.env.get('HOME').catch(() => undefined),
      $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined),
      $.session.id(),
    ])
    const dir = configDir || (home ? `${home.replace(/\/+$/, '')}/.claude` : null)
    if (!dir || !id) return
    const project = `${dir}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}`
    const names = await $.fs.list(project).then((xs) => xs.map((x) => x.name), () => [] as string[])
    if (!names.includes(`${id}.jsonl`) || view.store.logPath !== null) return
    await noteTranscript($, view.store, `${project}/${id}.jsonl`)
    redraw($, view)
  } catch {}
}

/** Puts a log a previous process wrote ahead of what this one has recorded since. */
async function adoptLog($: $, store: Store, path: string): Promise<void> {
  const text = await readText($, path)
  const restored = text === null ? null : parseLog(text)
  if (!restored || restored.length === 0) return
  const live = store.records
  store.load([...restored, ...live])
  store.unsaved = live.length
}

async function maybeFlush($: $, store: Store): Promise<void> {
  if (store.unsaved >= FLUSH_EVERY) await flush($, store)
}

async function flush($: $, store: Store): Promise<void> {
  if (!store.logPath || store.unsaved === 0) return
  const text = serializeLog(store.records)
  if (text.length > MAX_LOG_CHARS) return
  store.unsaved = 0
  try {
    await $.fs.write(store.logPath, text)
  } catch {
    store.unsaved = 1
  }
}

/** U-6 fallback: project and user skill folders by name → their SKILL.md. */
async function scanSkillFolders($: $, store: Store): Promise<Map<string, string>> {
  const cwd = store.cwd ?? (store.cwd = await $.session.root())
  const roots = [`${cwd}/.claude/skills`]
  if (store.claudeDir) roots.push(`${store.claudeDir}/skills`)
  const found = new Map<string, string>()
  for (const root of roots) {
    try {
      for (const entry of await $.fs.list(root)) {
        if (entry.kind === 'dir' && !found.has(entry.name)) found.set(entry.name, `${root}/${entry.name}/SKILL.md`)
      }
    } catch {}
  }
  return found
}

async function readText($: $, path: string): Promise<string | null> {
  try {
    const v = await $.fs.read(path)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

async function fileEndsWithNewline($: $, path: string): Promise<boolean | null> {
  const text = await readText($, path)
  return text === null ? null : text === '' || text.endsWith('\n')
}

async function fileLineCount($: $, path: string): Promise<number | null> {
  const text = await readText($, path)
  return text === null ? null : lineCount(text)
}
