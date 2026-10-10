// Replays a persisted ccfiles log and prints the derived view (live checks).
// Usage: bun mods/ccfiles/scripts/inspect-log.ts <path/to/log.jsonl>
import { readFileSync } from 'node:fs'
import { parseLog } from '../src/log.ts'
import { replay } from '../src/reducer.ts'
import { coveragePercent, footerLine, instructionSummaryLine, rangeSummary, totals, unverifiedMark } from '../src/summary.ts'
import { fmtEstTokens } from '../src/tokens.ts'

const path = process.argv[2]
if (!path) throw new Error('usage: inspect-log.ts <log.jsonl>')
const records = parseLog(readFileSync(path, 'utf8'))
if (!records) throw new Error('not a ccfiles log')
const s = replay(records)
for (const f of s.files.values()) {
  if (f.path.startsWith('skill-description:') && !f.path.endsWith(':demo')) continue
  const pct = coveragePercent(f)
  const instr = f.instruction ? ` [${f.instruction.mode} ${f.instruction.origin} loads=${f.instruction.loads} ${f.instruction.loadReasons.join(',')}${f.instruction.triggerPath ? ' trigger=' + f.instruction.triggerPath : ''}${f.instruction.parentPath ? ' parent=' + f.instruction.parentPath : ''}]` : ''
  console.log(
    `${f.path}  ${f.coverage}${unverifiedMark(f)}  ${rangeSummary(f)}  ${pct === null ? '' : pct + '%'}  reads=${f.reads} rereads=${f.rereads} hits=${f.hits}  ${fmtEstTokens(f.estTokens)}${instr}`,
  )
}
console.log(`skill descriptions: ${[...s.files.keys()].filter((k) => k.startsWith('skill-description:')).length}`)
console.log(instructionSummaryLine(s))
console.log(footerLine(s))
console.log('totals (exact ≈ sums):', JSON.stringify({ ...totals(s), epoch: s.epoch }))
