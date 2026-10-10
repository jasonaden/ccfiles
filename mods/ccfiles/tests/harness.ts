// Shared stubs for the stubbed-event tests: a fake file system, the fixture
// texts, real-shaped tool results, and a reader
// for what the mod persisted. Tests observe the mod through its log only.
import type { On } from 'claude-code'
import { mock, type Engine, type MockClock } from 'claude-code/testing'
import { parseLog } from '../src/log.ts'
import type { LogRecord, SessionState } from '../src/model.ts'
import { replay } from '../src/reducer.ts'

export const CWD = '/tmp/fv'
export const TRANSCRIPT = '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl'
export const LOG = '/home/u/.claude/projects/-tmp-ccfiles/s1/ccfiles/log.jsonl'
export const MEMORY = '/home/u/.claude/projects/-tmp-ccfiles/memory/MEMORY.md'

const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1))

export const BIG = range(1323, (i) => `big.md line ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join('\n') + '\n'
export const SMALL = ['// small.ts — 40 lines', ...range(38, (i) => `export const v${i + 1} = ${i + 1}; // line ${i + 1}`), '// end of small.ts (line 40)'].join('\n') + '\n'
export const SUB_A = ['// sub/a.ts', ...range(19, (i) => `export const a${i + 1} = ${i + 1};`)].join('\n') + '\n'
export const REFERENCE = range(600, (i) => `reference.md line ${i}: demo skill reference material.`).join('\n') + '\n'
export const MEMORY_DISK = ['# Memory index', ...range(259, (i) => `- memory line ${i + 1}: fixture fact number ${i + 1}`)].join('\n') + '\n'
/** What Claude Code loads: the first 200 lines plus its truncation warning. */
export const MEMORY_LOADED =
  MEMORY_DISK.split('\n').slice(0, 200).join('\n') +
  '\n\n> WARNING: MEMORY.md is 260 lines (limit: 200). Only the first 200 lines were loaded. Keep index entries to one line under ~200 chars; move detail into topic files.'

export const FILES: Record<string, string> = {
  [`${CWD}/big.md`]: BIG,
  [`${CWD}/small.ts`]: SMALL,
  [`${CWD}/sub/a.ts`]: SUB_A,
  [`${CWD}/.claude/skills/demo/reference.md`]: REFERENCE,
  [MEMORY]: MEMORY_DISK,
}

/** Where the mocked clock starts (2026-09-11, a realistic epoch-ms value). */
export const T0 = 1_789_000_000_000

export type Harness = {
  readonly clock: MockClock
  readonly written: Map<string, string>
  readonly reads: string[]
  /** Writes a file as the user would (bumps its mtime). */
  readonly put: (path: string, text: string) => void
  /** The view the persisted log replays to. */
  readonly state: () => SessionState
  readonly records: () => LogRecord[]
}

type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }

/**
 * Stubs fs, session.cwd and session.root. Register before the first `$` call. `list` overrides directory
 * listings; `sessionCwd` is where the session's cwd went (a Bash cd moves it; the root stays CWD).
 */
export function harness(on: On, files: Record<string, string> = FILES, list?: (path: string) => Entry[] | null, opts: { sessionCwd?: string } = {}): Harness {
  const written = new Map<string, string>()
  const reads: string[] = []
  const clock = mock.clock(on, { now: T0 })
  const mtimes = new Map<string, number>()
  const put = (path: string, text: string) => {
    written.set(path, text)
    mtimes.set(path, (mtimes.get(path) ?? 0) + 1000)
  }
  on('fs.write', (_$, e) => {
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = written.get(e.path) ?? files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', (_$, e) => {
    const custom = list?.(e.path)
    if (custom) return { value: custom }
    const dir = e.path.replace(/\/+$/, '') + '/'
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of [...Object.keys(files), ...written.keys()]) {
      if (!p.startsWith(dir)) continue
      const rest = p.slice(dir.length)
      const i = rest.indexOf('/')
      names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
    }
    if (names.size === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: mtimes.get(dir + name) ?? 1, isLink: false })) }
  })
  on('session.cwd', () => ({ value: opts.sessionCwd ?? CWD }))
  on('session.root', () => ({ value: CWD }))
  // Nothing beneath answers classic events in a test; settings hooks would answer {}.
  on('classic.*', () => ({}) as never)
  const records = () => {
    const text = written.get(LOG)
    if (text === undefined) throw new Error('nothing persisted at ' + LOG)
    const parsed = parseLog(text)
    if (!parsed) throw new Error('log did not parse')
    return parsed
  }
  return { clock, written, reads, put, records, state: () => replay(records()) }
}

export async function startSession($: Engine, source: 'startup' | 'resume' | 'compact' = 'startup') {
  await $.classic.SessionStart({ source, transcript_path: TRANSCRIPT, cwd: CWD } as never)
}

/** Ends the session, which writes the log. */
export async function endSession($: Engine) {
  await $.classic.SessionEnd({ reason: 'other' } as never)
}

/** A Read result shaped like 2.1.295's (U-7): totalLines counts the empty line after a final newline. */
export function readResult(path: string, text: string, startLine = 1, numLines?: number, truncatedByTokenCap?: boolean) {
  const all = text.split('\n')
  const n = numLines ?? all.length - (startLine - 1)
  const lines = all.slice(startLine - 1, startLine - 1 + n)
  const content = lines.join('\n')
  return {
    ref: 1,
    result: {
      type: 'text',
      file: { filePath: path, content, numLines: lines.length, startLine, totalLines: all.length, ...(truncatedByTokenCap ? { truncatedByTokenCap } : {}) },
    },
    text: lines.map((l, i) => `${startLine + i}\t${l}`).join('\n'),
    isReadOnly: true,
  }
}

export function bashResult(stdout: string) {
  return { ref: 1, result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: stdout, isReadOnly: true }
}

/** Answers tool calls in Claude Code's place; `call` fires one through the mod. */
export function tools(on: On) {
  const answers = new Map<string, unknown>()
  let n = 0
  on('tool.call', (_$, e) => answers.get(e.tool_use_id ?? '') as never)
  return {
    async call($: Engine, input: Record<string, unknown>, answer: unknown) {
      const id = `toolu_${++n}`
      answers.set(id, answer)
      return $.tool.call({ ...input, tool_use_id: id } as never)
    },
  }
}
