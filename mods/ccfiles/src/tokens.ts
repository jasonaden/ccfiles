// Token numbers. Estimates are characters ÷ 4 of the text Claude received and
// are only ever rendered through fmtEstTokens, which always marks them.
// Exact numbers come only from turn.step usage and render through fmtExactTokens.

export const ESTIMATE_MARKER = '≈'
export const ESTIMATE_LEGEND = 'estimated (chars ÷ 4)'
/** The footer's short exact marker (R5): `=63k`; the detail view's legend explains it, full values say "(exact)". */
export const EXACT_MARKER = '='

/** ceil(chars / 4), chars counted as UTF-16 code units. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** `≈850 tok`, `≈1.2k tok`, `≈12k tok`, `≈1.2M tok`; `≈? tok` when unknown. */
export function fmtEstTokens(n: number | null): string {
  return `${ESTIMATE_MARKER}${n === null ? '?' : compact(n)} tok`
}

/** `25,283 tok (exact)`; `25k tok (exact)` compact; `=25k` short (the footer). API-reported usage only. */
export function fmtExactTokens(n: number, opts: { compact?: boolean; short?: boolean } = {}): string {
  if (opts.short) return `${EXACT_MARKER}${compact(n)}`
  return `${opts.compact ? compact(n) : n.toLocaleString('en-US')} tok (exact)`
}

function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * Token figures in rendered text that carry neither the estimate marker
 * (`≈`/`~`) nor the exact label. Used by tests over whole rendered views.
 */
export function unmarkedTokenFigures(text: string): string[] {
  const out: string[] = []
  const re = /([≈~]?)(\d[\d.,]*[kM]?)\s?(tok(?:ens?)?)\b(\s*\(exact\))?/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] || m[4]) continue
    out.push(`${m[2]} ${m[3]}`.replace(/^(\S+) (tok)/, '$1 $2'))
  }
  return out
}
