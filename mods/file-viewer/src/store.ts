// The mod's live state: the log records, the view derived from them, and
// what isn't persisted (pending calls, selection).
import type { EventKind, LogRecord, SessionState } from './model.ts'
import { apply, emptyState } from './reducer.ts'
import { classifyPath } from './instructions.ts'
import { rootSpelling } from './paths.ts'

export type Pending = { readonly path: string; readonly kind: EventKind; readonly ts: number; readonly agentId: string | null }

/** Write the log after this many new records even without a turn boundary. */
export const FLUSH_EVERY = 25

export class Store {
  records: LogRecord[] = []
  state: SessionState = emptyState()
  logPath: string | null = null
  cwd: string | null = null
  /** The user's Claude config dir (`~/.claude`), from the transcript path. */
  claudeDir: string | null = null
  /** Records not yet written. */
  unsaved = 0
  /** Set by a compaction; the next prompt.context reloads are marked `compact`. */
  afterCompact = false
  /** Tool calls in flight, by tool_use_id (for the pending row). */
  readonly pending = new Map<string, Pending>()
  /** The file selected in the panel (selection-as-context). */
  selection: string | null = null

  add(r: LogRecord): void {
    // One spelling per file: a path through a macOS alias of the root (`/tmp` vs `/private/tmp`) takes the root's.
    if (r.t === 'event' && this.cwd) {
      const path = rootSpelling(r.e.path, this.cwd)
      if (path !== r.e.path) r = { ...r, e: { ...r.e, path } }
    }
    this.records.push(r)
    apply(this.state, r)
    this.unsaved += 1
  }

  /** Replaces everything with a restored log. */
  load(records: readonly LogRecord[]): void {
    this.records = []
    this.state = emptyState()
    for (const r0 of records) {
      const r = r0.t === 'event' && this.cwd ? { ...r0, e: { ...r0.e, path: rootSpelling(r0.e.path, this.cwd) } } : r0
      this.records.push(r)
      apply(this.state, r)
    }
    this.unsaved = 0
  }

  reset(): void {
    this.load([])
    this.pending.clear()
    this.afterCompact = false
    this.selection = null
  }

  agentType(id: string | null): string | null {
    return id === null ? null : this.state.agents.get(id) ?? null
  }

  /** The agent's Bash directory: a string, null when unknown, undefined when no cd moved it. */
  shellCwd(agentId: string | null): string | null | undefined {
    return this.state.shellCwd.get(agentId ?? 'main')
  }

  /** `~`, from the Claude config dir. */
  get home(): string | null {
    return this.claudeDir?.replace(/\/\.claude$/, '') ?? null
  }

  totalLines(path: string): number | null {
    return this.state.files.get(path)?.totalLines ?? null
  }

  isInstruction(path: string): boolean {
    return this.state.files.get(path)?.instruction != null || classifyPath(path) !== null
  }
}

/** The one line selection-as-context adds to a prompt. */
export function selectionLine(path: string, cwd: string | null): string {
  const shown = cwd && path.startsWith(cwd.replace(/\/+$/, '') + '/') ? path.slice(cwd.replace(/\/+$/, '').length + 1) : path
  return `The user has ${shown} selected in the File Viewer panel; "this file" or "this" may refer to it.`
}
