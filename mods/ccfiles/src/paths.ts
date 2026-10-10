// Path helpers (no Node `path` here: hooks run without Node).

/** Resolves `p` against `cwd` and normalizes `.`/`..`; `~` paths are kept as written. */
export function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('~')) return p
  const abs = p.startsWith('/') ? p : `${cwd.replace(/\/+$/, '')}/${p}`
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** macOS folders reachable under two names: `/tmp` is `/private/tmp`, and so on. */
const PRIVATE_ALIASES = ['/tmp/', '/var/', '/etc/']

/**
 * `path` spelled the way `root` is when they name the same place through a macOS alias (`/tmp/x/a.ts` under the root
 * `/private/tmp/x`, or the reverse), so one file never shows as two, or under a phantom outside root.
 */
export function rootSpelling(path: string, root: string | null): string {
  if (!root) return path
  const r = root.replace(/\/+$/, '') + '/'
  if (path.startsWith(r) || !path.startsWith('/')) return path
  for (const a of PRIVATE_ALIASES) {
    if (r.startsWith('/private' + a) && path.startsWith(a) && ('/private' + path).startsWith(r)) return '/private' + path
    if (r.startsWith(a) && path.startsWith('/private' + a) && path.slice(8).startsWith(r)) return path.slice(8)
  }
  return path
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** `p` relative to `root` when inside it, else `p`. */
export function relativeTo(root: string, p: string): string {
  const r = root.replace(/\/+$/, '')
  return p.startsWith(r + '/') ? p.slice(r.length + 1) : p
}
