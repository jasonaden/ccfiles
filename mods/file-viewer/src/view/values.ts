// The right column's four forms: ≈ tokens, lines read, modified date, size on disk. `Σ` cycles them.
import { dirname } from '../paths.ts'
export type ValueMode = 'tokens' | 'lines' | 'date' | 'size'

export const VALUE_MODES: readonly ValueMode[] = ['tokens', 'lines', 'date', 'size']

export function nextValueMode(m: ValueMode): ValueMode {
  return VALUE_MODES[(VALUE_MODES.indexOf(m) + 1) % VALUE_MODES.length]!
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `14:02` when modified today (local time), else `Oct 9`; a past year adds it: `Oct 9 2025`. */
export function fmtDate(mtimeMs: number, now: number): string {
  const d = new Date(mtimeMs)
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === n.getFullYear() ? md : `${md} ${d.getFullYear()}`
}

/** `812B`, `12K`, `1.4M`, `2.1G`: one decimal under 10, whole numbers above. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString()}${units[i]}`
}

/**
 * The date column for folders: `$.fs.list` gives a folder no modified time, so each folder above `files` takes its
 * newest file's (in place, on `info`; once per finished walk).
 */
export function folderTimes(info: Map<string, { size: number; mtimeMs: number }>, files: readonly string[]): void {
  const newest = new Map<string, number>()
  for (const p of files) {
    const t = info.get(p)?.mtimeMs ?? 0
    for (let d = dirname(p); d !== '/' && (newest.get(d) ?? -1) < t; d = dirname(d)) newest.set(d, t)
  }
  for (const [d, t] of newest) info.set(d, { size: info.get(d)?.size ?? 0, mtimeMs: t })
}
