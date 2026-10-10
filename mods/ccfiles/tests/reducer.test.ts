import { describe, expect, test } from 'claude-code/testing'
import { makeEvent, type FvEvent } from '../src/model.ts'
import { replay } from '../src/reducer.ts'

const BIG = '/tmp/fv/big.md'
const read = (path: string, ranges: [number, number][], extra: Partial<FvEvent> = {}) =>
  makeEvent({ kind: 'read', tool: 'Read', path, source: 'tool', ranges, estTokens: 100, ...extra })
const file = (events: FvEvent[], path: string) => replay(events.map((e) => ({ t: 'event', e }))).files.get(path)!

describe('reads', () => {
  test('two overlapping reads merge, count twice and flag the re-read', () => {
    const f = file([read(BIG, [[1, 200]], { totalLines: 1323 }), read(BIG, [[150, 349]], { totalLines: 1323 })], BIG)
    expect(f.intervals).toEqual([[1, 349]])
    expect(f.totalLines).toBe(1323)
    expect(f.reads).toBe(2)
    expect(f.rereads).toBe(1)
    expect(f.coverage).toBe('partial')
    expect(f.estTokens).toBe(200)
  })

  test('a read of new lines only is not a re-read', () => {
    const f = file([read(BIG, [[1, 200]]), read(BIG, [[201, 300]])], BIG)
    expect(f.rereads).toBe(0)
  })

  test('reading every line is full; a PARTIAL view covers only what came back', () => {
    expect(file([read('/tmp/fv/small.ts', [[1, 40]], { totalLines: 40 })], '/tmp/fv/small.ts').coverage).toBe('full')
    const p = file([read(BIG, [[1, 603]], { totalLines: 1323, truncated: true })], BIG)
    expect(p.intervals).toEqual([[1, 603]])
    expect(p.coverage).toBe('partial')
  })

  test('an unknown-range read is partial-unknown until the file is fully known', () => {
    const unknown = read(BIG, [], { unknownRange: true })
    expect(file([unknown], BIG).coverage).toBe('partial-unknown')
    expect(file([unknown, read(BIG, [[1, 1323]], { totalLines: 1323 })], BIG).coverage).toBe('full')
  })

  test('a search hit marks the file with no coverage or cost', () => {
    const f = file([makeEvent({ kind: 'hit', tool: 'Bash:grep', path: BIG, source: 'tool' })], BIG)
    expect(f.coverage).toBe('hit')
    expect(f.intervals).toEqual([])
    expect(f.estTokens).toBe(0)
    expect(f.hits).toBe(1)
  })

  test('denied and errored calls are logged but add nothing and light nothing', () => {
    const f = file(
      [read(BIG, [[1, 10]], { outcome: 'denied', estTokens: 0 }), read(BIG, [[1, 10]], { outcome: 'error', estTokens: 0 })],
      BIG,
    )
    expect(f.history).toHaveLength(2)
    expect(f.denied).toBe(1)
    expect(f.errors).toBe(1)
    expect(f.intervals).toEqual([])
    expect(f.reads).toBe(0)
    expect(f.estTokens).toBe(0)
    expect(f.lastAction).toBe(null)
    expect(f.coverage).toBe('none')
  })
})

describe('edits and writes', () => {
  test('an edit adding 5 for 3 shifts later intervals by +2 and grows the file', () => {
    const edit = makeEvent({
      kind: 'edit', tool: 'Edit', path: BIG, source: 'tool', linesAdded: 5, linesRemoved: 3, estTokens: 0, writtenTokens: 12,
      hunks: [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 5 }],
    })
    const f = file([read(BIG, [[1, 20]], { totalLines: 1323 }), read(BIG, [[100, 200]]), edit], BIG)
    expect(f.intervals).toEqual([[1, 20], [102, 202]])
    expect(f.totalLines).toBe(1325)
    expect([f.linesAdded, f.linesRemoved]).toEqual([5, 3])
    expect(f.lastAction).toBe('edit')
  })

  test('a write marks the file full; its payload is written, not cost', () => {
    const w = makeEvent({ kind: 'write', tool: 'Write', path: '/tmp/fv/new.ts', source: 'tool', whole: true, totalLines: 12, estTokens: 0, writtenTokens: 90 })
    const f = file([w], '/tmp/fv/new.ts')
    expect(f.coverage).toBe('full')
    expect(f.intervals).toEqual([[1, 12]])
    expect(f.estTokens).toBe(0)
    expect(f.writtenTokens).toBe(90)
  })
})

describe('instruction loads', () => {
  const CL = '/tmp/fv/CLAUDE.md'
  const il = (reason: string, extra: Partial<FvEvent> = {}) =>
    makeEvent({ kind: 'autoload', path: CL, source: 'instructionsLoaded', estTokens: null, loadReason: reason, memoryType: 'Project', ...extra })
  const content = (tokens: number) =>
    makeEvent({ kind: 'autoload', path: CL, source: 'promptContext', estTokens: tokens, whole: true, totalLines: 3, origin: 'project', loadReason: 'session_start' })
  const compact = makeEvent({ kind: 'compact', path: '', source: 'session' })

  test('InstructionsLoaded and the content that follows are one load', () => {
    const f = file([il('session_start'), content(20)], CL)
    expect(f.instruction).toMatchObject({ mode: 'auto', loads: 1, loadReasons: ['session_start'], origin: 'project' })
    expect(f.estTokens).toBe(20)
    expect(f.coverage).toBe('full')
  })

  test('the same content again in the same compaction epoch is not counted twice (e.g. on resume)', () => {
    const f = file([il('session_start'), content(20), il('session_start'), content(20)], CL)
    expect(f.instruction?.loads).toBe(1)
    expect(f.estTokens).toBe(20)
  })

  test('after /compact the reload is marked and counted again', () => {
    const f = file([il('session_start'), content(20), compact, il('compact'), content(20)], CL)
    expect(f.instruction?.loads).toBe(2)
    expect(f.instruction?.loadReasons).toEqual(['session_start', 'compact'])
    expect(f.estTokens).toBe(40)
  })

  test('a capped auto-load covers only the loaded lines and is capped', () => {
    const MEM = '/home/u/.claude/projects/-tmp-ccfiles/memory/MEMORY.md'
    const f = file(
      [makeEvent({ kind: 'autoload', path: MEM, source: 'promptContext', estTokens: 2154, origin: 'memory', ranges: [[1, 200]], totalLines: 260, capped: true })],
      MEM,
    )
    expect(f.coverage).toBe('capped')
    expect(f.intervals).toEqual([[1, 200]])
    expect(f.totalLines).toBe(260)
    expect(f.instruction?.capped).toBe(true)
  })

  test('a file read under an invoked skill is grouped under it as read via tool', () => {
    const skill = makeEvent({ kind: 'skillLoad', path: '/tmp/fv/.claude/skills/demo/SKILL.md', source: 'skillPrompt', estTokens: 40, owner: { kind: 'skill', name: 'demo' }, origin: 'skill', whole: true })
    const ref = '/tmp/fv/.claude/skills/demo/reference.md'
    const f = file([skill, read(ref, [[1, 200]], { totalLines: 600 })], ref)
    expect(f.owner).toEqual({ kind: 'skill', name: 'demo' })
    expect(f.instruction).toMatchObject({ mode: 'tool', origin: 'skill' })
    expect(Math.round((200 / (f.totalLines ?? 1)) * 100)).toBe(33)
  })

  test('a file auto-loaded and later read via a tool shows both, and each load counts', () => {
    const f = file([il('session_start'), content(20), read(CL, [[1, 3]], { totalLines: 3, estTokens: 10 })], CL)
    expect(f.instruction?.mode).toBe('both')
    expect(f.estTokens).toBe(30)
  })
})

describe('replay', () => {
  test('agent and usage records build the session view', () => {
    const s = replay([
      { t: 'agent', ts: 1, agentId: 'a1', agentType: 'Explore' },
      { t: 'usage', ts: 2, agentId: null, model: 'm', usage: { input_tokens: 2, output_tokens: 155, cache_read_input_tokens: 25283, cache_creation_input_tokens: 22477 } },
      { t: 'usage', ts: 3, agentId: 'a1', model: 'm', usage: { input_tokens: 2, output_tokens: 106, cache_read_input_tokens: 0, cache_creation_input_tokens: 18780 } },
    ])
    expect(s.agents.get('a1')).toBe('Explore')
    expect(s.usage).toEqual({ requests: 2, input: 4, output: 261, cacheRead: 25283, cacheCreation: 41257 })
    expect(s.usageByAgent.get('main')?.output).toBe(155)
    expect(s.usageByAgent.get('a1')?.cacheCreation).toBe(18780)
    expect(s.latestContext).toBe(2 + 25283 + 22477)
  })
})
