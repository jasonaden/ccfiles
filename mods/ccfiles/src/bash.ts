// Bash command → what it did to files: reads (with ranges when knowable),
// search hits, listings, and git verbs. Pure: the hook supplies cwd, output
// and any file totals it looked up.
import type { Range } from './intervals.ts'
import { normalize } from './intervals.ts'
import { splitCommand, type Stage } from './shell.ts'
import { estTokens } from './tokens.ts'
import { resolvePath } from './paths.ts'

type ReadSpec =
  | { readonly type: 'whole' }
  | { readonly type: 'head'; readonly n: number }
  | { readonly type: 'tail'; readonly n: number }
  | { readonly type: 'from'; readonly start: number }
  | { readonly type: 'ranges'; readonly ranges: readonly (readonly [number, number | null])[] }
  | { readonly type: 'unknown' }

type ParsedRead = { readonly kind: 'read'; readonly program: string; readonly files: readonly string[]; readonly spec: ReadSpec; readonly piped: boolean }
/**
 * `dir`: where the program ran, which its output's relative paths are relative to. `out`: its lines reach the
 * command's stdout as it wrote them; false when another program consumed them (`rg -l X | xargs cat`).
 * `shared`: other commands write stdout too, so a bare line can't be told apart from theirs.
 */
type ParsedSearch = {
  readonly kind: 'search'
  readonly program: string
  readonly files: readonly string[]
  readonly mode: 'lines' | 'paths' | 'counts'
  readonly withName: boolean | 'auto'
  readonly dir: string
  readonly out: boolean
  readonly shared: boolean
}
type ParsedListing = { readonly kind: 'listing'; readonly program: 'find' | 'ls' | 'wc'; readonly files: readonly string[]; readonly dir: string; readonly out: boolean; readonly shared: boolean }
export type ParsedAction = ParsedRead | ParsedSearch | ParsedListing

export type ParsedCommand = {
  readonly actions: readonly ParsedAction[]
  /** git subcommands in order (`commit`, `push`, ...). */
  readonly git: readonly string[]
  /** The shell's directory once the command ran, when it ran a `cd`; null = unknown (`cd -`). */
  readonly cwdAfter?: string | null
  /** Actions parsed after the directory became unknown (their paths are guesses). */
  readonly unknownFrom?: number
  /** A cd in the command went to an absolute path or home, so `cwdAfter` doesn't rest on the starting dir. */
  readonly cwdAnchored?: boolean
}

export type BashAction = {
  readonly kind: 'read' | 'hit' | 'listing'
  readonly tool: string
  readonly path: string
  readonly ranges: readonly Range[]
  /** A read whose lines can't be known (partial-unknown). */
  readonly unknown: boolean
  /** File length learned from this command, when it reveals it. */
  readonly totalLines: number | null
  readonly estTokens: number
  readonly verified: boolean
}

export type BashContext = {
  readonly cwd: string
  /** The user's home, for `cd` and `cd ~`. */
  readonly home?: string | null
  /** False when the shell's directory is unknown (after `cd -`): paths are guesses. */
  readonly cwdKnown?: boolean
  /** The command's stdout as the tool recorded it. */
  readonly stdout: string
  /** What Claude received (`r.text`); may be a preview of stdout. */
  readonly text: string
  /** Known normalized line count for an absolute path, or null. */
  readonly totals: (path: string) => number | null
}

/** Caps how many listing/hit rows one command can produce. */
export const MAX_PATHS_PER_COMMAND = 200

const READERS = new Set(['cat', 'nl', 'head', 'tail', 'sed', 'awk'])
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg'])
const PREFIXES = new Set(['time', 'command', 'nohup', 'builtin', 'exec'])

/** Key prefix for a relative path read while the shell's directory is unknown: never resolved to a guess. */
export const UNRESOLVED = 'unresolved:'

export function parseCommand(command: string, cwd: string, home: string | null = null, cwdKnown = true): ParsedCommand {
  const actions: ParsedAction[] = []
  const git: string[] = []
  let dir = cwd
  let known = cwdKnown
  let cwdAfter: string | null | undefined
  let unknownFrom: number | undefined
  let anchored = false
  const pipelines = splitCommand(command)
  // How many commands write the stdout we get: one search alone owns its lines; with others, bare lines are ambiguous.
  const shared = pipelines.filter(writesStdout).length > 1
  for (const pipeline of pipelines) {
    const first = pipeline[0]
    if (!first) continue
    const words = stripPrefixes(first.words)
    const program = basename(words[0] ?? '')
    if (program === 'cd' && pipeline.length === 1) {
      // Claude Code's Bash keeps the shell between calls, so a cd outlives the command.
      const target = cdTarget(words.slice(1), dir, home)
      const arg = words.slice(1).find((a) => !/^-[LPe@]+$/.test(a))
      if (target !== null && (arg === undefined || arg.startsWith('/') || arg.startsWith('~'))) anchored = true
      if (target === null) {
        unknownFrom ??= actions.length
        anchored = false
        known = false
      } else {
        dir = target
        if (anchored) known = true
      }
      cwdAfter = target === null ? null : dir
      continue
    }
    if (program === 'git') {
      const verb = gitVerb(words.slice(1))
      if (verb) git.push(verb)
      continue
    }
    const piped = pipeline.length > 1
    // From an unknown directory a relative path names no file we can know: keep it unresolved.
    const resolve = (f: string) => (known || f.startsWith('/') || f.startsWith('~') ? resolvePath(dir, f) : UNRESOLVED + f)
    const stage: Stage = { words, stdin: first.stdin }
    // The first program's lines reach stdout only through filters that keep each line as it was (head, sort, grep).
    const out = !first.toFile && pipeline.slice(1).every(keepsLines)
    if (READERS.has(program)) {
      const read = parseReader(program, stage)
      const files = read ? read.files.filter(literal) : []
      if (read && files.length > 0) actions.push({ ...read, files: files.map(resolve), piped })
    } else if (SEARCHERS.has(program)) {
      const s = parseSearch(program, stage, dir)
      actions.push({ ...s, files: s.files.filter(literal).map(resolve), dir, out, shared })
    } else if (program === 'find' || program === 'ls' || program === 'wc') {
      const files = operands(words.slice(1), program === 'find' ? FIND_VALUE_FLAGS : new Set())
      const targets = program === 'find' ? [files[0] ?? '.'] : files.length > 0 ? files : program === 'ls' ? ['.'] : []
      const known = targets.filter(literal)
      if (known.length > 0) actions.push({ kind: 'listing', program, files: known.map(resolve), dir, out, shared })
    }
    // `… | xargs rg -n Y`: the search xargs runs writes stdout, over files we don't know.
    const last = pipeline[pipeline.length - 1]!
    const sub = piped ? xargsCommand(last.words) : null
    if (sub && SEARCHERS.has(basename(sub[0] ?? '')) && !last.toFile) {
      const s = parseSearch(basename(sub[0]!), { words: sub, stdin: null }, dir)
      actions.push({ ...s, files: s.files.map(resolve), withName: s.withName === false ? false : true, dir, out: true, shared })
    }
  }
  return { actions, git, ...(cwdAfter !== undefined ? { cwdAfter, cwdAnchored: anchored } : {}), ...(unknownFrom !== undefined ? { unknownFrom } : {}) }
}

/** Where `cd <args>` lands: home for none or `~`, null for `cd -` (the previous dir isn't tracked). */
function cdTarget(args: readonly string[], dir: string, home: string | null): string | null {
  const arg = args.find((a) => !/^-[LPe@]+$/.test(a))
  // `cd -`, a variable, a substitution or a glob: the shell knows where it went, we don't.
  if (arg === '-' || (arg !== undefined && /[$`*?[]/.test(arg))) return null
  if (arg === undefined || arg === '~') return home
  if (arg.startsWith('~/')) return home === null ? null : resolvePath(home, arg.slice(2))
  return resolvePath(dir, arg)
}

/** Claude Code's note when it moved the shell back (cd outside the allowed dirs). */
export function shellResetDir(text: string): string | null {
  return /Shell cwd was reset to (\S.*?)\s*$/m.exec(text)?.[1] ?? null
}

/** Absolute paths whose totals `bashActions` needs to place the lines read. */
export function pathsNeedingTotals(parsed: ParsedCommand): string[] {
  const out: string[] = []
  const reads = parsed.actions.filter((a): a is ParsedRead => a.kind === 'read')
  for (const a of reads) {
    if (a.piped) continue
    const multi = reads.length > 1 || a.files.length > 1
    const needs =
      a.spec.type === 'tail' ||
      a.spec.type === 'from' ||
      (a.spec.type === 'ranges' && a.spec.ranges.some(([, b]) => b === null)) ||
      (a.spec.type === 'whole' && multi)
    if (needs) out.push(...a.files)
  }
  return [...new Set(out)]
}

export function bashActions(command: string, ctx: BashContext): BashAction[] {
  const parsed = parseCommand(command, ctx.cwd, ctx.home ?? null, ctx.cwdKnown !== false)
  const preview = previewLines(ctx.text)
  const shown = preview ?? countLines(ctx.stdout)
  const reads = parsed.actions.filter((a): a is ParsedRead => a.kind === 'read')
  const readFiles = reads.reduce((n, a) => n + a.files.length, 0)
  // Output line counts bound a read only when one file produced all of stdout.
  const solo = readFiles === 1 && !reads[0]?.piped && parsed.actions.length === 1
  const perFileTokens = readFiles > 0 ? Math.round(estTokens(ctx.text) / readFiles) : 0
  const verified = preview === null && ctx.cwdKnown !== false

  const out: BashAction[] = []
  const seen = new Set<string>()
  for (const [i, a] of parsed.actions.entries()) {
    const known = parsed.unknownFrom === undefined || i < parsed.unknownFrom
    if (a.kind === 'read') {
      for (const path of a.files) {
        const placed = place(a, ctx.totals(path), solo ? shown : null, preview !== null)
        out.push({ kind: 'read', tool: `Bash:${a.program}`, path, ...placed, estTokens: perFileTokens, verified: verified && known })
      }
    } else if (a.kind === 'search') {
      if (!a.out) continue
      for (const path of searchHits(a, ctx.stdout, a.dir)) {
        if (seen.has(path) || seen.size >= MAX_PATHS_PER_COMMAND) continue
        seen.add(path)
        out.push(blank('hit', `Bash:${a.program}`, path))
      }
    } else if (a.program === 'find') {
      if (!a.out) continue
      const root = a.files[0] ?? ctx.cwd
      const base = root.endsWith('/') ? root : root
      for (const line of ctx.stdout.split('\n')) {
        const p = line.trim()
        if (!p || seen.size >= MAX_PATHS_PER_COMMAND) continue
        const path = resolvePath(a.dir, p)
        if (seen.has(path) || path === base) continue
        seen.add(path)
        out.push(blank('listing', 'Bash:find', path))
      }
    } else if (a.program === 'wc') {
      const counts = wcCounts(ctx.stdout, a.dir)
      for (const path of a.files) out.push({ ...blank('listing', 'Bash:wc', path), totalLines: counts.get(path) ?? null })
    } else {
      for (const path of a.files) out.push(blank('listing', `Bash:${a.program}`, path))
    }
  }
  return out
}

function blank(kind: 'hit' | 'listing', tool: string, path: string): BashAction {
  return { kind, tool, path, ranges: [], unknown: false, totalLines: null, estTokens: 0, verified: true }
}

function place(
  a: ParsedRead,
  total: number | null,
  shown: number | null,
  isPreview: boolean,
): { ranges: Range[]; unknown: boolean; totalLines: number | null } {
  const unknown = { ranges: [], unknown: true, totalLines: total }
  if (a.piped) return unknown
  const spec = a.spec
  const clamp = (r: readonly Range[]) => normalize(total === null ? r : r.map(([s, e]) => [s, Math.min(e, total)] as const))
  switch (spec.type) {
    case 'unknown':
      return unknown
    case 'whole': {
      if (shown !== null && (isPreview || total === null)) {
        // The whole file came out unless it was cut to a preview.
        return { ranges: shown > 0 ? [[1, shown]] : [], unknown: false, totalLines: isPreview ? total : shown }
      }
      if (total === null) return unknown
      return { ranges: total > 0 ? [[1, total]] : [], unknown: false, totalLines: total }
    }
    case 'head': {
      let end = spec.n
      let learned = total
      if (shown !== null) {
        end = Math.min(end, shown)
        if (shown < spec.n && !isPreview) learned = shown
      }
      return { ranges: clamp(end > 0 ? [[1, end]] : []), unknown: false, totalLines: learned }
    }
    case 'tail':
      if (total === null) return unknown
      return { ranges: clamp(total > 0 ? [[Math.max(1, total - spec.n + 1), total]] : []), unknown: false, totalLines: total }
    case 'from':
      if (total === null) return unknown
      return { ranges: clamp(spec.start <= total ? [[spec.start, total]] : []), unknown: false, totalLines: total }
    case 'ranges': {
      const single = spec.ranges.length === 1
      const resolved: Range[] = []
      for (const [s, e] of spec.ranges) {
        let end = e ?? total
        if (single && shown !== null) end = end === null ? s + shown - 1 : Math.min(end, s + shown - 1)
        if (end === null) return unknown
        resolved.push([s, end])
      }
      return { ranges: clamp(resolved), unknown: false, totalLines: total }
    }
  }
}

// ---- readers ---------------------------------------------------------------

const NL_VALUE_FLAGS = new Set(['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'])

function parseReader(program: string, stage: Stage): Omit<ParsedRead, 'piped'> | null {
  const args = stage.words.slice(1)
  const withStdin = (files: string[]) => (files.length === 0 && stage.stdin ? [stage.stdin] : files)
  switch (program) {
    case 'cat': {
      const files = withStdin(args.filter((w) => w === '--' || !w.startsWith('-') || w === '-').filter((w) => w !== '-' && w !== '--'))
      return files.length ? { kind: 'read', program, files, spec: { type: 'whole' } } : null
    }
    case 'nl': {
      const files = withStdin(operands(args, NL_VALUE_FLAGS))
      return files.length ? { kind: 'read', program, files, spec: { type: 'whole' } } : null
    }
    case 'head':
    case 'tail':
      return parseHeadTail(program, args, withStdin)
    case 'sed':
      return parseSed(args, withStdin)
    case 'awk': {
      const files = withStdin(operands(args, new Set(['-F', '-v', '-f'])).slice(1))
      return files.length ? { kind: 'read', program, files, spec: { type: 'unknown' } } : null
    }
  }
  return null
}

function parseHeadTail(program: 'head' | 'tail', args: readonly string[], withStdin: (f: string[]) => string[]): Omit<ParsedRead, 'piped'> | null {
  let n: number | null = 10
  let from: number | null = null
  let bad = false
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    let value: string | undefined
    if (w === '-n' || w === '--lines') value = args[++i]
    else if (w.startsWith('--lines=')) value = w.slice(8)
    else if (/^-n.+/.test(w)) value = w.slice(2)
    else if (/^-\d+$/.test(w)) value = w.slice(1)
    else if (program === 'tail' && /^\+\d+$/.test(w)) value = w
    else if (w === '-c' || w.startsWith('-c') || w.startsWith('--bytes')) {
      bad = true
      if (w === '-c') i++
      continue
    } else if (w.startsWith('-') && w !== '-') continue
    else {
      files.push(w)
      continue
    }
    if (value === undefined) bad = true
    else if (program === 'tail' && value.startsWith('+')) from = Number(value.slice(1))
    else if (/^\d+$/.test(value)) n = Number(value)
    else bad = true
  }
  const all = withStdin(files)
  if (all.length === 0) return null
  const spec: ReadSpec = bad || n === null ? { type: 'unknown' } : from !== null ? { type: 'from', start: Math.max(1, from) } : { type: program, n }
  return { kind: 'read', program, files: all, spec }
}

function parseSed(args: readonly string[], withStdin: (f: string[]) => string[]): Omit<ParsedRead, 'piped'> | null {
  let quiet = false
  const scripts: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '-n' || w === '--quiet' || w === '--silent') quiet = true
    else if (w === '-i' || w.startsWith('-i') || w.startsWith('--in-place')) return null
    else if (w === '-e' || w === '--expression') scripts.push(args[++i] ?? '')
    else if (w.startsWith('--expression=')) scripts.push(w.slice(13))
    else if (w === '-f') return null
    else if (/^-[nEr]+$/.test(w)) quiet = quiet || w.includes('n')
    else if (w.startsWith('-') && w !== '-') continue
    else rest.push(w)
  }
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!)
  const files = withStdin(rest)
  if (files.length === 0) return null
  return { kind: 'read', program: 'sed', files, spec: sedSpec(scripts.join(';'), quiet) }
}

function sedSpec(script: string, quiet: boolean): ReadSpec {
  const parts = script.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return { type: 'unknown' }
  if (!quiet) {
    // `sed 5q` / `sed 5,5q`: prints lines 1..5 and stops.
    const q = parts.length === 1 ? /^(\d+)q$/.exec(parts[0]!) : null
    return q ? { type: 'head', n: Number(q[1]) } : { type: 'unknown' }
  }
  const ranges: (readonly [number, number | null])[] = []
  for (const p of parts) {
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(p)
    if (m) {
      ranges.push([Number(m[1]), m[2] === undefined ? Number(m[1]) : m[2] === '$' ? null : Number(m[2])])
      continue
    }
    if (/^\d+q$/.test(p)) continue
    return { type: 'unknown' }
  }
  return { type: 'ranges', ranges }
}

// ---- search ----------------------------------------------------------------

const GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--max-count', '--context', '--after-context', '--before-context'])
const RG_VALUE_FLAGS = new Set([...GREP_VALUE_FLAGS, '-g', '--glob', '-t', '--type', '-T', '--type-not', '-j', '--threads', '--iglob', '-M', '--max-columns'])
const FIND_VALUE_FLAGS = new Set<string>()

function parseSearch(program: string, stage: Stage, _cwd: string): Omit<ParsedSearch, 'files' | 'dir' | 'out' | 'shared'> & { files: string[] } {
  const args = stage.words.slice(1)
  const valueFlags = program === 'rg' ? RG_VALUE_FLAGS : GREP_VALUE_FLAGS
  let hasPatternFlag = false
  let recursive = program === 'rg'
  let mode: ParsedSearch['mode'] = 'lines'
  let withName: boolean | 'auto' = 'auto'
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (valueFlags.has(w)) {
      if (w === '-e' || w === '-f') hasPatternFlag = true
      i++
      continue
    }
    if (w.startsWith('--')) {
      if (w === '--files-with-matches' || w === '--files') mode = 'paths'
      else if (w === '--count') mode = 'counts'
      else if (w === '--recursive') recursive = true
      else if (w === '--no-filename') withName = false
      else if (w === '--with-filename') withName = true
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      const letters = w.slice(1)
      if (/[rR]/.test(letters)) recursive = true
      if (letters.includes('l')) mode = 'paths'
      if (letters.includes('c')) mode = 'counts'
      if (letters.includes('h')) withName = false
      if (letters.includes('H')) withName = true
      if (/[efmABCgtTj]$/.test(letters) && letters.length > 1) i++
      if (letters.includes('e')) hasPatternFlag = true
      continue
    }
    positional.push(w)
  }
  if (program === 'rg' && args.includes('--files')) mode = 'paths'
  const files = hasPatternFlag || (program === 'rg' && mode === 'paths' && args.includes('--files')) ? positional : positional.slice(1)
  if (files.length === 0 && stage.stdin) files.push(stage.stdin)
  if (withName === 'auto') withName = recursive || files.length > 1 || (program === 'rg' && files.length === 0) ? true : files.length === 1 ? false : 'auto'
  return { kind: 'search', program, files, mode, withName }
}

/**
 * The files a search's output names. `path:line:text` (and `path:text`, `path-line-text` context lines)
 * name `path`; with -l / --files a bare line is a path, but only when this search alone writes stdout. Anything
 * else (diff lines, markdown, prose) names nothing. The hook still drops what isn't a file on disk.
 */
function searchHits(a: ParsedSearch, stdout: string, cwd: string): string[] {
  const out: string[] = []
  const lines = stdout.split('\n').filter((l) => l.trim() !== '' && !/^Binary file .* matches$/.test(l))
  if (lines.length === 0) return out
  if (a.withName === false || (a.withName === 'auto' && a.files.length === 1)) {
    if (a.mode === 'counts' && lines.every((l) => /^0$/.test(l.trim()))) return out
    return a.files.length === 1 && !a.shared ? [a.files[0]!] : out
  }
  for (const line of lines) {
    let p: string | null = null
    if (a.mode === 'paths') p = a.shared ? null : line
    else if (a.mode === 'counts') p = /:0$/.test(line) ? null : (/^(.+):\d+$/.exec(line)?.[1] ?? null)
    else p = matchPath(line, a.shared)
    if (p && p !== '--') out.push(resolvePath(cwd, p))
  }
  return [...new Set(out)]
}

/** The path a `grep -n` / `rg -n` style line names: `path:12:text`, else (when not shared) `path-12-text` or `path:text`. */
export function matchPath(line: string, strict = false): string | null {
  const numbered = /^(.+?):(\d+):/.exec(line)
  if (numbered) return numbered[1]!
  if (strict) return null
  return /^(.+?)-(\d+)-/.exec(line)?.[1] ?? /^(.+?):/.exec(line)?.[1] ?? null
}

/** Whether a command writes to the stdout Claude gets (cd, mkdir and friends write nothing; `> file` neither). */
function writesStdout(pipeline: readonly Stage[]): boolean {
  const last = pipeline[pipeline.length - 1]
  if (!last || last.toFile) return false
  const program = basename(stripPrefixes(pipeline[0]!.words)[0] ?? '')
  return !(pipeline.length === 1 && SILENT.has(program))
}

/** A later pipeline stage that passes each line through unchanged or drops it: head, tail, sort, uniq, a grep filter. */
function keepsLines(stage: Stage): boolean {
  const words = stripPrefixes(stage.words)
  const program = basename(words[0] ?? '')
  if (stage.toFile) return false
  if (program === 'head' || program === 'tail' || program === 'sort' || program === 'uniq') return true
  // `| grep foo` with no file of its own filters the lines before it (not -c, -l, -o: those rewrite them).
  if (SEARCHERS.has(program)) {
    const s = parseSearch(program, { words, stdin: null }, '')
    return s.files.length === 0 && s.mode === 'lines' && !words.some((w) => /^-[a-zA-Z]*o/.test(w) || w === '--only-matching')
  }
  return false
}

/** `xargs [-0 -n1 -I{} …] cmd args` → `cmd args`; null when the stage isn't xargs. */
function xargsCommand(words: readonly string[]): string[] | null {
  const w = stripPrefixes(words)
  if (basename(w[0] ?? '') !== 'xargs') return null
  let i = 1
  while (i < w.length && w[i]!.startsWith('-')) i += XARGS_VALUE_FLAGS.has(w[i]!) ? 2 : 1
  return i < w.length ? w.slice(i) : null
}

const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'])
/** Commands that write nothing to stdout on their own. */
const SILENT = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'set', 'true', ':', 'mkdir', 'touch', 'rm', 'rmdir', 'cp', 'mv', 'ln', 'chmod', 'source', '.'])

// ---- helpers -----------------------------------------------------------------

function wcCounts(stdout: string, cwd: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const r = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (r && r[2] !== 'total') m.set(resolvePath(cwd, r[2]!), Number(r[1]))
  }
  return m
}

/** A word the shell passes as written: no variable, substitution or glob, whose real value we can't know. */
const literal = (w: string) => !/[$`*?[]/.test(w)

function operands(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (valueFlags.has(w)) {
      i++
      continue
    }
    if (w.startsWith('-') && w !== '-') continue
    out.push(w)
  }
  return out
}

function stripPrefixes(words: readonly string[]): readonly string[] {
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || PREFIXES.has(words[i]!) || words[i] === 'sudo')) i++
  return words.slice(i)
}

function gitVerb(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') {
      i++
      continue
    }
    if (w.startsWith('-')) continue
    return w
  }
  return null
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Lines in a stdout string (no trailing newline counted). */
function countLines(s: string): number {
  if (s === '') return 0
  return s.replace(/\n$/, '').split('\n').length
}

/**
 * When Claude got a `<persisted-output>` preview instead of the output, the
 * complete lines in the preview; null when it got the whole output.
 */
export function previewLines(text: string): number | null {
  if (!text.includes('<persisted-output>')) return null
  const m = /Preview \(first [^)]*\):\n([\s\S]*?)(?:\n\.\.\.)?\n<\/persisted-output>/.exec(text)
  if (!m) return 0
  const body = m[1]!.split('\n')
  return Math.max(0, body.length - 1)
}
