// Parsers for read-only git command output. The hook runs the commands; this module only reads text.

import { resolvePath } from './paths.ts'

/** Porcelain v1 status letter shown in rows. '?' untracked, '!' ignored. */
export type GitLetter = 'A' | 'M' | 'D' | 'R' | '?' | '!'

export type GitFile = {
  /** Absolute. */
  readonly path: string
  readonly letter: GitLetter
  /** The index (X) side has a change. */
  readonly staged: boolean
  /** Absolute old path of a rename or copy. */
  readonly origPath?: string
}

export type NumStat = { readonly added: number; readonly removed: number; readonly binary: boolean }

export type GitSnapshot = {
  readonly root: string
  readonly branch: string | null
  readonly head: string | null
  readonly ahead: number | null
  readonly behind: number | null
  /** The upstream branch (`origin/main`), when one is set. */
  readonly upstream?: string | null
  readonly files: ReadonlyMap<string, GitFile & NumStat>
}

/** The argv lists the hook runs, in order, for one refresh (all read-only). */
export const GIT_COMMANDS = {
  root: ['git', 'rev-parse', '--show-toplevel'],
  status: ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
  numstat: ['git', 'diff', '--numstat', 'HEAD'],
  aheadBehind: ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'],
  branch: ['git', 'branch', '--show-current'],
  head: ['git', 'rev-parse', 'HEAD'],
  upstream: ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
} as const

const XY = /^[ MTADRCU]$/

function letterOf(x: string, y: string): GitLetter | null {
  if (x === '?' && y === '?') return '?'
  if (x === '!' && y === '!') return '!'
  if (!XY.test(x) || !XY.test(y) || (x === ' ' && y === ' ')) return null
  if (x === 'R' || x === 'C') return 'R'
  if (x === 'A') return 'A'
  if (x === 'D' || y === 'D') return 'D'
  return 'M'
}

/**
 * `git status --porcelain=v1 -z` (optionally `--ignored`) → files resolved against `root`.
 * A rename/copy entry is followed by its old path as the next NUL field. Unknown codes are skipped.
 */
export function parsePorcelain(stdout: string, root: string): GitFile[] {
  const fields = stdout.split('\0')
  const out: GitFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 4 || f[2] !== ' ') continue
    const x = f[0]!
    const y = f[1]!
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    const orig = renamed ? fields[++i] : undefined
    const letter = letterOf(x, y)
    if (!letter) continue
    const staged = x !== ' ' && x !== '?' && x !== '!'
    const path = resolvePath(root, f.slice(3))
    out.push(orig ? { path, letter, staged, origPath: resolvePath(root, orig) } : { path, letter, staged })
  }
  return out
}

/** Undoes git's C-style path quoting (`"t\303\251.txt"`); unquoted input is returned as is. */
function unquote(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p
  const body = p.slice(1, -1)
  const esc: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  let enc = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== '\\') {
      enc += encodeURIComponent(c)
      continue
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1))
    if (oct) {
      enc += '%' + parseInt(oct[0], 8).toString(16).padStart(2, '0')
      i += 3
    } else {
      const next = body[++i] ?? ''
      enc += encodeURIComponent(esc[next] ?? next)
    }
  }
  try {
    return decodeURIComponent(enc)
  } catch {
    return body
  }
}

/** `a => b` → b; `dir/{a => b}/f` → dir/b/f (an empty side collapses its slash). */
function renamedTo(p: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p)
  if (brace) return brace[1]! + brace[3]! + brace[4]!
  const i = p.indexOf(' => ')
  return unquote(i < 0 ? p : p.slice(i + 4))
}

/** `git diff --numstat [HEAD]` → absolute path → counts. `-\t-\t` is binary; renames key on the new path. */
export function parseNumstat(stdout: string, root: string): Map<string, NumStat> {
  const out = new Map<string, NumStat>()
  for (const line of stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const binary = m[1] === '-' && m[2] === '-'
    const added = binary ? 0 : Number(m[1])
    const removed = binary ? 0 : Number(m[2])
    out.set(resolvePath(root, renamedTo(m[3]!)), { added, removed, binary })
  }
  return out
}

/** `git rev-list --left-right --count @{u}...HEAD` → "behind\tahead"; null on empty or garbage. */
export function parseAheadBehind(stdout: string): { readonly ahead: number; readonly behind: number } | null {
  const m = /^(\d+)\s+(\d+)$/.exec(stdout.trim())
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null
}

/** First line, trimmed; '' → null. For `rev-parse --show-toplevel` and `rev-parse HEAD`. */
export function firstLine(stdout: string): string | null {
  const line = (stdout.split('\n')[0] ?? '').trim()
  return line === '' ? null : line
}

/** `git branch --show-current` → name; null when empty (detached HEAD). */
export function parseBranch(stdout: string): string | null {
  return firstLine(stdout)
}

/** Combines the parsed outputs; files without numstat get 0/0. */
export function snapshot(parts: {
  root: string
  status: string
  numstat: string
  aheadBehind: string
  branch: string
  head: string
  upstream?: string
}): GitSnapshot {
  const root = firstLine(parts.root) ?? ''
  const counts = parseNumstat(parts.numstat, root)
  const files = new Map<string, GitFile & NumStat>()
  for (const f of parsePorcelain(parts.status, root)) {
    files.set(f.path, { ...f, ...(counts.get(f.path) ?? { added: 0, removed: 0, binary: false }) })
  }
  const ab = parseAheadBehind(parts.aheadBehind)
  return {
    root,
    branch: parseBranch(parts.branch),
    head: firstLine(parts.head),
    ahead: ab ? ab.ahead : null,
    behind: ab ? ab.behind : null,
    upstream: firstLine(parts.upstream ?? '') ?? null,
    files,
  }
}

/** `git show --name-only --format= <sha>` or `git diff-tree --no-commit-id --name-only -r <sha>` → absolute paths. */
export function parseNameOnly(stdout: string, root: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => resolvePath(root, unquote(l)))
}

const SHA = /^[0-9a-f]{7,40}$/i

function shaAt(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null
  const op = (v as { gitOperation?: unknown }).gitOperation
  if (typeof op !== 'object' || op === null) return null
  const commit = (op as { commit?: unknown }).commit
  const nested = typeof commit === 'object' && commit !== null ? (commit as { sha?: unknown }).sha : undefined
  for (const s of [nested, (op as { sha?: unknown }).sha]) if (typeof s === 'string' && SHA.test(s)) return s
  return null
}

/**
 * The commit sha of a Bash tool result: `result.result.gitOperation.commit.sha` or `.gitOperation.sha`
 * (2.1.295 shape unverified live), else git's own `[main a1c9e42] msg` / `[main (root-commit) a1c9e42] msg` line.
 */
export function commitShaFromBash(result: unknown, stdout: string): string | null {
  const inner = typeof result === 'object' && result !== null ? (result as { result?: unknown }).result : undefined
  const reported = shaAt(inner)
  if (reported) return reported
  const m = /^\[[^\]\n]* ([0-9a-f]{7,40})\] /m.exec(stdout)
  return m ? m[1]! : null
}

/** Whether a refresh may run now: never ran, at least `minIntervalMs` passed, or the clock went back. */
export function shouldRefresh(lastRun: number | null, now: number, minIntervalMs = 2000): boolean {
  return lastRun === null || now < lastRun || now - lastRun >= minIntervalMs
}

/** Files whose status letter or line counts differ from the previous snapshot (what a Bash call just wrote). */
export function changedFiles(prev: GitSnapshot | null, next: GitSnapshot): (GitFile & NumStat)[] {
  const out: (GitFile & NumStat)[] = []
  for (const f of next.files.values()) {
    const p = prev?.files.get(f.path)
    if (!p || p.letter !== f.letter || p.added !== f.added || p.removed !== f.removed) out.push(f)
  }
  return out
}

/** Files that changed between two commits (read-only): what a commit Claude made touched. */
export function diffNamesCommand(from: string, to: string): readonly string[] {
  return ['git', 'diff', '--name-only', from, to]
}
