// The persisted session log: JSONL next to the transcript, one LogRecord per
// line after a header. Replaying it through the reducer restores the view.
import type { LogRecord } from './model.ts'

export const LOG_VERSION = 1
/** `$.fs.write` refuses files over 4 MiB; stay under it. */
export const MAX_LOG_CHARS = 3_800_000

/** `~/.claude/projects/<p>/<session>.jsonl` → `~/.claude/projects/<p>/<session>/file-viewer/log.jsonl` */
export function logPathFor(transcriptPath: string): string | null {
  const m = /^(.*)\/([^/]+)\.jsonl$/.exec(transcriptPath)
  return m ? `${m[1]}/${m[2]}/file-viewer/log.jsonl` : null
}

/** `~/.claude/projects/<p>/<session>.jsonl` → `~/.claude` (the user's Claude config dir). */
export function claudeDirOf(transcriptPath: string): string | null {
  const m = /^(.*)\/projects\/[^/]+\/[^/]+\.jsonl$/.exec(transcriptPath)
  return m ? m[1]! : null
}

export function serializeLog(records: readonly LogRecord[]): string {
  return [JSON.stringify({ t: 'header', v: LOG_VERSION }), ...records.map((r) => JSON.stringify(r))].join('\n') + '\n'
}

/** Parses a log; unreadable lines and unknown record types are skipped. Null when it isn't a log of ours. */
export function parseLog(text: string): LogRecord[] | null {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const header = tryJson(lines[0] ?? '')
  if (!header || header.t !== 'header' || header.v !== LOG_VERSION) return null
  const out: LogRecord[] = []
  for (const line of lines.slice(1)) {
    const r = tryJson(line)
    if (r && (r.t === 'event' || r.t === 'usage' || r.t === 'agent' || r.t === 'injected' || r.t === 'shell' || r.t === 'step')) out.push(r as LogRecord)
  }
  return out
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
