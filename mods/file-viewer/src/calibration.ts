// Local token calibration. Learns, from the turn.step usage the viewer
// already logs, how many tokens a Read really adds: a per-call overhead plus a
// content ratio (tokens per character). Pure, on the machine, no network.
//
// Anthropic's count_tokens API (a possible opt-in alternative) is deliberately
// not implemented: any `$.http` call, even behind an off-by-default flag, shows up in
// `claude plugin validate`'s `calls:` line, and the mod makes no network calls.
//
// A calibrated figure is still an estimate and is rendered with the ≈ marker.
import type { LogRecord, Usage } from './model.ts'

/** One attributed Read: what Claude received (chars) and what the next request grew by (tokens). */
export type Sample = { readonly chars: number; readonly real: number }

export type Calibration = {
  /** Tokens every call adds besides its content (result framing, per-request reminders). */
  readonly overhead: number
  /** Tokens per character of content. chars ÷ 4 is 0.25. */
  readonly ratio: number
  readonly samples: number
}

/** Below this many samples only a content ratio is learned; the overhead stays 0. */
export const MIN_SAMPLES_FOR_OVERHEAD = 3
/** Per-request reminders (`total_tokens_reminder` and the like) below this many ≈ tokens are part of the overhead. */
const ROUTINE_INJECTED = 100

/**
 * Least squares on relative error: real ≈ overhead + ratio × chars, each sample weighted 1/real² so small
 * reads count as much as large ones. Null without samples.
 */
export function fitCalibration(samples: readonly Sample[]): Calibration | null {
  const ok = samples.filter((s) => s.chars > 0 && s.real > 0)
  if (ok.length === 0) return null
  const ratioOnly = (): Calibration => ({ overhead: 0, ratio: throughOrigin(ok), samples: ok.length })
  if (ok.length < MIN_SAMPLES_FOR_OVERHEAD) return ratioOnly()
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const { chars: x, real: y } of ok) {
    const w = 1 / (y * y)
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y
  }
  const det = sw * sxx - sx * sx
  if (det <= 0) return ratioOnly()
  const ratio = (sw * sxy - sx * sy) / det
  const overhead = (sy - ratio * sx) / sw
  if (overhead < 0 || ratio <= 0) return ratioOnly()
  return { overhead, ratio, samples: ok.length }
}

/** Ratio of the line through the origin, same weighting. */
function throughOrigin(samples: readonly Sample[]): number {
  let num = 0, den = 0
  for (const { chars: x, real: y } of samples) {
    num += x / y
    den += (x * x) / (y * y)
  }
  return num / den
}

/** ≈ tokens for content of `chars` characters: calibrated when a fit exists, else chars ÷ 4. */
export function calibratedTokens(cal: Calibration | null, chars: number): number {
  if (!cal) return Math.ceil(chars / 4)
  return Math.round(cal.overhead + cal.ratio * chars)
}

type UsageRecord = Extract<LogRecord, { t: 'usage' }>
type EventRecord = Extract<LogRecord, { t: 'event' }>

const contextSize = (u: Usage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/**
 * Attributes Reads to real usage (U-10). An agent's request k owns what is logged between its `step` marker and
 * the agent's next one: the attachments built for it, its usage, and the events of the tools it asked for (Claude
 * Code waits for the tool.call hook, which logs first, before the next request). When request k asked for exactly
 * one tool and that is a Read, request k+1's context grew by: request k's output + the Read's result + what was
 * attached for request k+1 (logged in its window before its usage). Skipped: a shrinking context (compaction),
 * another tool result, or more than small per-request reminders attached in between (an instruction load).
 */
export function readSamples(records: readonly LogRecord[]): Sample[] {
  /** `attached`: ≈ tokens of non-tool records before the usage; `late`: after it. */
  type Step = { usage: UsageRecord | null; reads: EventRecord[]; attached: number; late: number }
  const steps = new Map<string, Step[]>()
  for (const r of records) {
    const agent = (r.t === 'event' ? r.e.agentId : r.agentId) ?? 'main'
    const list = steps.get(agent) ?? []
    if (r.t === 'step') {
      list.push({ usage: null, reads: [], attached: 0, late: 0 })
      steps.set(agent, list)
      continue
    }
    const cur = list[list.length - 1]
    if (!cur) continue
    if (r.t === 'usage') cur.usage ??= r
    const tokens = r.t === 'event' ? (r.e.estTokens ?? 0) : r.t === 'injected' ? r.estTokens : 0
    if (tokens <= 0) continue
    if (r.t === 'event' && r.e.source === 'tool') cur.reads.push(r)
    else if (cur.usage) cur.late += tokens
    else cur.attached += tokens
  }
  const out: Sample[] = []
  for (const list of steps.values()) {
    for (let k = 0; k + 1 < list.length; k++) {
      const { usage, reads, late } = list[k]!
      const next = list[k + 1]!
      if (!usage || !next.usage || usage.tools !== 1 || reads.length !== 1 || late + next.attached >= ROUTINE_INJECTED) continue
      const e = reads[0]!.e
      if (e.kind !== 'read' || e.tool !== 'Read' || e.outcome !== 'ok') continue
      const real = contextSize(next.usage.usage) - contextSize(usage.usage) - usage.usage.output_tokens
      if (real > 0) out.push({ chars: e.estTokens! * 4, real })
    }
  }
  return out
}
