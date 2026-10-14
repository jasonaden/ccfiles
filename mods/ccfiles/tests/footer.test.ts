import { describe, expect, test } from 'claude-code/testing'
import { makeEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { footerParts } from '../src/summary.ts'
import { unmarkedTokenFigures } from '../src/tokens.ts'
import { agentLines } from '../src/view/detail.ts'

const usage = (agentId: string | null, input: number, cacheRead: number, cacheCreation: number, output: number): LogRecord => ({
  t: 'usage',
  ts: 1,
  agentId,
  model: 'claude-opus-5-5',
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation },
})

// Three main requests and one subagent request, as turn.step reports them.
const SESSION: LogRecord[] = [
  { t: 'event', e: makeEvent({ kind: 'read', tool: 'Read', path: '/tmp/fv/big.md', source: 'tool', ranges: [[1, 200]], totalLines: 1323, estTokens: 4_000 }) },
  usage(null, 2, 25_283, 22_721, 104),
  usage(null, 2, 48_004, 7_532, 4),
  usage('a1', 2, 0, 18_780, 106),
  usage(null, 2, 65_430, 158, 148),
]

describe('footer', () => {
  test('context = the latest main request (input + cache read + cache creation); billed ∑ = every request summed', () => {
    const s = replay(SESSION)
    expect(s.latestContext).toBe(2 + 65_430 + 158)
    expect(s.billedSum).toBe(2 + 25_283 + 22_721 + (2 + 48_004 + 7_532) + (2 + 18_780) + (2 + 65_430 + 158))
    const parts = footerParts(s, [])
    expect(parts[0]).toMatchObject({ text: 'context =66k', primary: true, row: 0 })
    expect(parts.find((p) => p.text.startsWith('billed ∑'))).toMatchObject({ text: 'billed ∑ =188k incl. cache re-reads', row: 1 })
    // The summed figure is never called context, and nothing else claims to be the context.
    for (const p of parts) if (p.text.includes('∑')) expect(p.text).not.toContain('context')
    expect(parts.filter((p) => p.text.startsWith('context'))).toHaveLength(1)
    expect(parts.some((p) => p.text === 'out =362')).toBe(true)
    for (const p of parts) expect(unmarkedTokenFigures(p.text)).toEqual([])
    // Every footer figure carries a marker: = exact (API usage) or ≈ estimated.
    for (const p of parts) if (!p.text.startsWith('committed')) expect(p.text.replace(/\d+%/, '')).not.toMatch(/(^|[^≈=\d.,])\d/)
  })

  // The one-line footer is laid out by src/view/header.ts footerLine and
  // drawn by the panel (tests/header.test.ts, tests/panel.test.ts). footerParts stays for the log line.
  test('the full exact values and the marker legend are in the usage view (u)', () => {
    const s = replay(SESSION)
    const text = agentLines(s)
      .map((l) => l.map((c) => c.text).join(''))
      .join('\n')
    expect(text).toMatch(/context +65,590 tok \(exact\)/)
    expect(text).toMatch(/billed +∑ 187,916 tok \(exact\) incl\. cache re-reads/)
    expect(text).toMatch(/out +362 tok \(exact\)/)
    expect(text).toContain('≈ estimated (chars ÷ 4) · = exact (API usage')
    expect(unmarkedTokenFigures(text)).toEqual([])
  })
})
