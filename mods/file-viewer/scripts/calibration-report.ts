// Prints markdown tables from a measured dataset (JSON array of
// reads: session, path, lang, offset, limit, lines, chars, real|null, group, error). Calibrated figures come
// from src/calibration.ts, the code the mod ships. Usage:
//   node --experimental-strip-types scripts/calibration-report.ts dataset.json > report.md
import { readFileSync } from 'node:fs'
import { calibratedTokens, fitCalibration, type Sample } from '../src/calibration.ts'

type Row = {
  session: string; path: string; lang: string; offset: number | null; limit: number | null
  lines: number; chars: number; real: number | null; group: number; error: boolean
}
type Read = Row & { real: number }

const rows: Row[] = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const sessions = [...new Set(rows.map((r) => r.session))]
const usable = (s: string): Read[] => rows.filter((r): r is Read => r.session === s && r.real !== null && !r.error)
const est = (chars: number) => Math.ceil(chars / 4)
const sample = (r: Read): Sample => ({ chars: r.chars, real: r.real })

/** Held out: the fit from every other read of the session. */
const loo = (rs: Read[]) => rs.map((r, i) => calibratedTokens(fitCalibration(rs.filter((_, j) => j !== i).map(sample)), r.chars))
/** Live: what the panel would show at the moment of the read (only earlier reads known). */
const live = (rs: Read[]) => rs.map((r, i) => calibratedTokens(fitCalibration(rs.slice(0, i).map(sample)), r.chars))
/** Not built: overhead + ratio × chars + per-line term, same weighting, held out. */
const looLines = (rs: Read[]) => rs.map((r, i) => {
  const c = fitLines(rs.filter((_, j) => j !== i))
  return Math.round(c[0] + c[1] * r.chars + c[2] * r.lines)
})

function fitLines(rs: Read[]): [number, number, number] {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0]
  for (const r of rs) {
    const x = [1, r.chars, r.lines], w = 1 / (r.real * r.real)
    for (let i = 0; i < 3; i++) {
      b[i]! += w * x[i]! * r.real
      for (let j = 0; j < 3; j++) A[i]![j]! += w * x[i]! * x[j]!
    }
  }
  return solve3(A, b)
}

function solve3(A: number[][], b: number[]): [number, number, number] {
  const m = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < 3; c++) {
    const p = m.reduce((best, _, r) => (r >= c && Math.abs(m[r]![c]!) > Math.abs(m[best]![c]!) ? r : best), c)
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!]
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i)
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (i - lo)
}
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`
const f2 = (x: number) => x.toFixed(2)
const n0 = (x: number) => x.toLocaleString('en-US')
const size = (r: Read) => (r.lines < 50 ? 'small (<50 lines)' : r.lines > 500 ? 'large (>500 lines)' : 'mid (50–500)')
const range = (r: Row) => (r.offset === null ? 'full' : `${r.offset}–${r.offset + (r.lines || r.limit!) - 1}`)

type Method = { name: string; shown: (rs: Read[]) => number[] }
const METHODS: Method[] = [
  { name: 'chars ÷ 4 (raw)', shown: (rs) => rs.map((r) => est(r.chars)) },
  { name: 'calibrated, held out', shown: loo },
  { name: 'calibrated, live', shown: live },
  { name: 'calibrated + lines term, held out (not built)', shown: looLines },
]

const out: string[] = []
const p = (s = '') => out.push(s)

// Per-file table: the first session, with the other sessions' real cost beside it.
const [first, ...others] = sessions
const base = usable(first!)
const baseLoo = loo(base)
p(`### Per read (${first}; real cost in the other sessions alongside)`)
p()
p(`| # | lang | file | range | lines | chars | est | real | real÷est | calibrated | error | ${others.map((s) => `real (${s})`).join(' | ')} |`)
p(`|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|${others.map(() => '---:').join('|')}|`)
base.forEach((r, i) => {
  const twins = others.map((s) => usable(s).find((o) => o.path === r.path && o.offset === r.offset && o.chars === r.chars)?.real)
  p(`| ${i + 1} | ${r.lang} | \`${r.path}\` | ${range(r)} | ${n0(r.lines)} | ${n0(r.chars)} | ${n0(est(r.chars))} | ${n0(r.real)} | ${f2(r.real / est(r.chars))} | ${n0(baseLoo[i]!)} | ${pct(baseLoo[i]! / r.real - 1)} | ${twins.map((t) => (t === undefined ? '—' : n0(t))).join(' | ')} |`)
})
p()
const skipped = rows.filter((r) => r.session === first && (r.real === null || r.error))
if (skipped.length) {
  p(`Not attributable in ${first}: ${skipped.map((r) => `\`${r.path}\` ${range(r)} (${r.error ? 'error result' : `${r.group} reads in one request`})`).join('; ')}.`)
  p()
}

// Fitted constants per session.
p('### Fitted per session (all reads of the session)')
p()
p('| session | reads | overhead (tok/call) | ratio (tok/char) | ratio ÷ 0.25 | session total: chars ÷ 4 | calibrated | real |')
p('|---|---:|---:|---:|---:|---:|---:|---:|')
for (const s of sessions) {
  const rs = usable(s), cal = fitCalibration(rs.map(sample))!
  const tot = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const real = tot(rs.map((r) => r.real))
  const raw = tot(rs.map((r) => est(r.chars))), calTot = tot(rs.map((r) => calibratedTokens(cal, r.chars)))
  p(`| ${s} | ${rs.length} | ${cal.overhead.toFixed(1)} | ${cal.ratio.toFixed(4)} | ${(cal.ratio / 0.25).toFixed(2)}× | ${n0(raw)} (${pct(raw / real - 1)}) | ${n0(calTot)} (${pct(calTot / real - 1)}) | ${n0(real)} |`)
}
p()

// Distributions.
type Pt = { r: Read; shown: number }
const points = (m: Method, filter: (r: Read) => boolean = () => true): Pt[] =>
  sessions.flatMap((s) => {
    const rs = usable(s), shown = m.shown(rs)
    return rs.map((r, i) => ({ r, shown: shown[i]! })).filter((x) => filter(x.r))
  })
const distRow = (label: string, pts: Pt[]) => {
  const ratio = pts.map((x) => x.r.real / x.shown), err = pts.map((x) => x.shown / x.r.real - 1)
  return `| ${label} | ${pts.length} | ${f2(q(ratio, 0.5))} | ${f2(q(ratio, 0.1))} / ${f2(q(ratio, 0.9))} | ${f2(Math.min(...ratio))} / ${f2(Math.max(...ratio))} | ${pct(q(err, 0.5))} | ${pct(q(err, 0.1))} / ${pct(q(err, 0.9))} | ${pct(Math.min(...err))} / ${pct(Math.max(...err))} | ${(q(err.map(Math.abs), 0.5) * 100).toFixed(1)}% |`
}
const header = () => {
  p('| split | n | real÷shown median | p10 / p90 | min / max | % error median | p10 / p90 | min / max | median \\|error\\| |')
  p('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
}
for (const m of METHODS) {
  p(`### ${m.name}`)
  p()
  header()
  p(distRow('all sessions', points(m)))
  for (const s of sessions) p(distRow(`session ${s}`, points(m, (r) => r.session === s)))
  for (const l of ['ts', 'py', 'md']) p(distRow(`lang ${l}`, points(m, (r) => r.lang === l)))
  for (const z of ['small (<50 lines)', 'mid (50–500)', 'large (>500 lines)']) p(distRow(z, points(m, (r) => size(r) === z)))
  p()
}

// Tolerance menu.
const TOL = [0.1, 0.15, 0.25, 0.5]
p('### Tolerance menu (share of reads within ±tolerance of real, all sessions)')
p()
p(`| method | ${TOL.map((t) => `±${t * 100}%`).join(' | ')} | worst read | session totals within |`)
p(`|---|${TOL.map(() => '---:').join('|')}|---:|---:|`)
for (const m of METHODS) {
  const pts = points(m), abs = pts.map((x) => Math.abs(x.shown / x.r.real - 1))
  const totals = sessions.map((s) => {
    const sp = pts.filter((x) => x.r.session === s)
    return Math.abs(sp.reduce((a, x) => a + x.shown, 0) / sp.reduce((a, x) => a + x.r.real, 0) - 1)
  })
  p(`| ${m.name} | ${TOL.map((t) => `${((abs.filter((a) => a <= t).length / abs.length) * 100).toFixed(0)}%`).join(' | ')} | ${(Math.max(...abs) * 100).toFixed(1)}% | ${(Math.max(...totals) * 100).toFixed(1)}% |`)
}
p()
console.log(out.join('\n'))
