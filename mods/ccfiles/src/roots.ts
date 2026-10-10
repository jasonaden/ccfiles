// Root sections and focus. Which root a touched path belongs to, the Tree's section order,
// section labels, the focus breadcrumb, and which directories still need a `git rev-parse`. Pure: the hook supplies
// the added directories, the cached git answers and a project-marker lookup, and runs git after `next(e)`.
import { basename, dirname, resolvePath } from './paths.ts'
import { cellWidth, truncateMiddle } from './view/text.ts'

/** Files whose presence makes a directory a project root. */
export const PROJECT_MARKERS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'] as const

/** Which rule picked a root: the session root, then the added directories, git roots, project markers and parents. */
export type RootVia = 'session' | 'added' | 'git' | 'marker' | 'parent'

export type ResolvedRoot = {
  readonly root: string
  readonly via: RootVia
  /** The git answer for the path's directory isn't cached yet: steps 3–4 stand in until it is. */
  readonly provisional: boolean
}

export type RootContext = {
  readonly sessionRoot: string
  readonly home: string
  /** `classic.DirectoryAdded` directories and `permissions.additionalDirectories` (step 1). */
  readonly addedDirs: readonly string[]
  /** The cached git root for a directory: a path, null when it isn't in a repo, undefined when not asked yet. */
  readonly gitTopLevel: (dir: string) => string | null | undefined
  /** Whether the directory itself holds one of PROJECT_MARKERS (step 3). */
  readonly hasMarker: (dir: string) => boolean
}

export type Section = {
  readonly root: string
  readonly via: RootVia
  /** The section's files, in the order given. */
  readonly files: readonly string[]
}

function trim(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** `path` is `dir` or inside it. */
export function isUnder(path: string, dir: string): boolean {
  const p = trim(path)
  const d = trim(dir)
  if (d === '/') return p.startsWith('/')
  return p === d || p.startsWith(d + '/')
}

/** `~` for home, `~/Projects/x` under it, the path unchanged elsewhere. */
export function homeShort(path: string, home: string): string {
  const p = trim(path)
  const h = trim(home)
  if (h === '' || h === '/') return p
  if (p === h) return '~'
  return isUnder(p, h) ? `~${p.slice(h.length)}` : p
}

/** A section header's label: the root home-shortened, middle-truncated to `width` cells. */
export function sectionLabel(root: string, home: string, width: number): string {
  return truncateMiddle(homeShort(root, home), width)
}

/** Under `~/.claude/` (instructions, auto memory, settings): never a section of its own. */
function inClaudeDir(path: string, home: string): boolean {
  return isUnder(path, `${trim(home)}/.claude`)
}

/** Home and `/` are too broad to be a project root: a dotfiles repo or a stray `~/package.json` would swallow everything. */
function tooBroad(dir: string, home: string): boolean {
  return dir === '/' || dir === trim(home)
}

/**
 * A root that can't own the folders under it: home, `/`, or a folder holding the session root (a monorepo's top
 * above a package session). Only the parent rule picks one, for a file sitting directly in it (`~/.zshrc`,
 * `/m/README.md`); its section holds just those files, never folds another root in, and draws no listing.
 */
export function looseRoot(root: string, sessionRoot: string, home: string): boolean {
  const r = trim(root)
  return tooBroad(r, home) || isUnder(sessionRoot, r)
}

/** The deepest of `dirs` that holds `path`, or null. */
function deepest(path: string, dirs: readonly string[]): string | null {
  let best: string | null = null
  for (const d of dirs) if (isUnder(path, d) && (best === null || trim(d).length > best.length)) best = trim(d)
  return best
}

/**
 * The root a touched path belongs to, first match wins: the session root for paths under it; a directory
 * from the added list; the cached git root of the path's directory; the nearest ancestor holding a project marker;
 * the path's parent directory. Null for paths under `~/.claude/`. Steps 1–3 never pick home, `/` or a folder holding
 * the session root; step 4 may (a loose root, see looseRoot).
 */
export function resolveRoot(path: string, ctx: RootContext): ResolvedRoot | null {
  const p = trim(path)
  if (isUnder(p, ctx.sessionRoot)) return { root: trim(ctx.sessionRoot), via: 'session', provisional: false }
  if (inClaudeDir(p, ctx.home)) return null
  const holds = (d: string) => looseRoot(d, ctx.sessionRoot, ctx.home)
  const added = deepest(p, ctx.addedDirs.filter((d) => !holds(d)))
  if (added !== null) return { root: added, via: 'added', provisional: false }
  const dir = dirname(p)
  const git = ctx.gitTopLevel(dir)
  if (git && isUnder(dir, git) && !holds(trim(git))) return { root: trim(git), via: 'git', provisional: false }
  const provisional = git === undefined
  // Walking up, once a folder is too broad every folder above it is too.
  for (let d = dir; !holds(d); d = dirname(d)) {
    if (ctx.hasMarker(d)) return { root: d, via: 'marker', provisional }
  }
  return { root: dir, via: 'parent', provisional }
}

/**
 * The Tree's root sections: the session root first (always, even with no files), then one section per outside root
 * in order of first appearance in `paths` (pass them in first-touch order). A root inside another outside root
 * folds into the outer one, which keeps the earlier position of the two; a loose root (looseRoot) folds nothing in.
 * Paths under `~/.claude/` are left out. Linear in the paths times their depth.
 */
export function sections(paths: readonly string[], ctx: RootContext): Section[] {
  const sessionFiles: string[] = []
  const outside: { path: string; root: string }[] = []
  const viaOf = new Map<string, RootVia>()
  for (const path of paths) {
    const r = resolveRoot(path, ctx)
    if (r === null) continue
    if (r.via === 'session') {
      sessionFiles.push(path)
      continue
    }
    outside.push({ path, root: r.root })
    if (!viaOf.has(r.root)) viaOf.set(r.root, r.via)
  }
  // Each distinct root's outermost enclosing root, found by walking up its ancestors once.
  const top = new Map<string, string>()
  for (const root of viaOf.keys()) {
    let outer = root
    for (let d = root; d !== '/'; ) {
      d = dirname(d)
      if (viaOf.has(d) && !looseRoot(d, ctx.sessionRoot, ctx.home)) outer = d
    }
    top.set(root, outer)
  }
  const merged = new Map<string, { root: string; via: RootVia; files: string[] }>()
  for (const o of outside) {
    const t = top.get(o.root)!
    let s = merged.get(t)
    if (!s) merged.set(t, (s = { root: t, via: viaOf.get(t)!, files: [] }))
    s.files.push(o.path)
  }
  return [{ root: trim(ctx.sessionRoot), via: 'session', files: sessionFiles }, ...merged.values()]
}

/**
 * The directories whose git root isn't cached yet, each once: what the hook runs `rev-parse` for after `next(e)`.
 * Paths under the session root, an added directory or `~/.claude/` never need one.
 */
export function gitDirsToResolve(paths: readonly string[], ctx: RootContext): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    const p = trim(path)
    if (isUnder(p, ctx.sessionRoot) || inClaudeDir(p, ctx.home) || deepest(p, ctx.addedDirs) !== null) continue
    const dir = dirname(p)
    if (ctx.gitTopLevel(dir) === undefined) out.add(dir)
  }
  return [...out]
}

/**
 * `git -C <dir> rev-parse --show-toplevel --show-prefix`: the top level, and the directory's place inside it.
 * The prefix lets a symlinked path (`/tmp` → `/private/tmp` on macOS) keep the spelling the session uses.
 */
export function revParseArgv(dir: string): string[] {
  return ['git', '-C', dir, 'rev-parse', '--show-toplevel', '--show-prefix']
}

/** The git root for `dir` from `revParseArgv`'s output, spelled like `dir`; null when it failed (not a repo). */
export function parseRevParse(dir: string, out: { exitCode: number; stdout: string } | null): string | null {
  if (!out || out.exitCode !== 0) return null
  const [top = '', prefix = ''] = out.stdout.split('\n')
  if (top.trim() === '') return null
  const rel = prefix.trim().replace(/\/+$/, '')
  const d = trim(dir)
  if (rel === '') return d
  if (d.endsWith('/' + rel)) return d.slice(0, d.length - rel.length - 1) || '/'
  return trim(top.trim())
}

/**
 * The focus breadcrumb's segments: `acme-web-app ▸ packages ▸ api-layer` under the session root,
 * `~/Projects/other ▸ src` under an outside root (`roots`), and the home-shortened path split at `/` above or
 * outside every root (`~ ▸ Projects`).
 */
export function breadcrumb(focus: string, sessionRoot: string, home: string, roots: readonly string[] = []): string[] {
  const f = trim(focus)
  const below = (root: string, head: string) => [head, ...f.slice(trim(root).length).split('/').filter(Boolean)]
  if (isUnder(f, sessionRoot)) return below(sessionRoot, basename(trim(sessionRoot)) || '/')
  const outside = deepest(f, roots)
  if (outside !== null && outside !== '/') return below(outside, homeShort(outside, home))
  const short = homeShort(f, home)
  if (short.startsWith('/')) return ['/', ...short.split('/').filter(Boolean)]
  return short.split('/').filter(Boolean)
}

/**
 * The breadcrumb as one string of at most `width` cells: whole when it fits, else the middle segments become `…`,
 * then the first goes too; the last segment is kept whole as long as it fits on its own.
 */
export function fitBreadcrumb(segments: readonly string[], width: number, sep = ' ▸ '): string {
  const join = (s: readonly string[]) => s.join(sep)
  if (cellWidth(join(segments)) <= width) return join(segments)
  const last = segments[segments.length - 1] ?? ''
  if (segments.length > 2) {
    const kept = join([segments[0]!, '…', last])
    if (cellWidth(kept) <= width) return kept
  }
  const tail = join(['…', last])
  if (segments.length > 1 && cellWidth(tail) <= width) return tail
  return truncateMiddle(last, Math.max(0, width))
}

/**
 * The settings files that may list `permissions.additionalDirectories`: the project's shared and
 * local settings, then the user's (`configDir` is CLAUDE_CONFIG_DIR, else `~/.claude`; null skips it).
 */
export function settingsFiles(cwd: string, configDir: string | null): string[] {
  const c = trim(cwd)
  return [`${c}/.claude/settings.json`, `${c}/.claude/settings.local.json`, ...(configDir ? [`${trim(configDir)}/settings.json`] : [])]
}

/**
 * `permissions.additionalDirectories` from one settings file's text, as absolute paths: `~/…` against `home`, a
 * relative path against `cwd`. Best effort: unreadable text, bad JSON or another shape gives none.
 */
export function additionalDirectories(text: string | null, cwd: string, home: string): string[] {
  if (text === null) return []
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const perms = typeof json === 'object' && json !== null ? (json as { permissions?: unknown }).permissions : undefined
  const dirs = typeof perms === 'object' && perms !== null ? (perms as { additionalDirectories?: unknown }).additionalDirectories : undefined
  if (!Array.isArray(dirs)) return []
  const out: string[] = []
  for (const d of dirs) {
    if (typeof d !== 'string' || d.trim() === '') continue
    const raw = d.trim()
    const abs = raw === '~' || raw.startsWith('~/') ? (home ? `${trim(home)}${raw.slice(1)}` : null) : resolvePath(cwd, raw)
    if (abs && !out.includes(trim(abs))) out.push(trim(abs))
  }
  return out
}

/**
 * Git per section: the top level of the repo an outside section shows, spelled like the section. A root git
 * picked is its own top level; an added directory takes the cached answer for itself (undefined: not asked yet);
 * marker and parent roots aren't in a repo (their directory's git answer was "not a repo").
 */
export function sectionRepo(sec: Pick<Section, 'root' | 'via'>, gitTopLevel: (dir: string) => string | null | undefined): string | null | undefined {
  if (sec.via === 'git') return trim(sec.root)
  if (sec.via === 'added') return gitTopLevel(trim(sec.root))
  return null
}

/**
 * The repo a focused folder outside the session root sits in: the repo of the section holding it, else the cached
 * answer for the folder itself (undefined: not asked yet; null: in no repo, e.g. above every root).
 */
export function focusRepo(focus: string, secs: readonly Pick<Section, 'root' | 'via'>[], gitTopLevel: (dir: string) => string | null | undefined): string | null | undefined {
  const f = trim(focus)
  for (const sec of secs) {
    const top = sectionRepo(sec, gitTopLevel)
    if (isUnder(f, sec.root) && typeof top === 'string' && isUnder(f, top)) return top
  }
  return gitTopLevel(f)
}

/** Focus's parent for `↑`; it may go above the session root. Null at `/`. */
export function parentFocus(focus: string): string | null {
  const f = trim(focus)
  return f === '/' ? null : dirname(f)
}
