import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import { serializeLog } from '../src/log.ts'
import { makeEvent } from '../src/model.ts'
import { coveragePercent, footerLine, instructionGroups, instructionSummaryLine, rangeSummary, totals, unverifiedMark } from '../src/summary.ts'
import { fmtEstTokens, unmarkedTokenFigures } from '../src/tokens.ts'
import { detailLines } from '../src/view/detail.ts'
import { CWD, LOG, MEMORY, MEMORY_LOADED, REFERENCE, SMALL, SUB_A, endSession, harness, readResult, startSession, tools } from './harness.ts'

const CLAUDE = `${CWD}/CLAUDE.md`
const STYLE = `${CWD}/docs/style.md`
const AGENTS = `${CWD}/AGENTS.md`
const RULE = `${CWD}/.claude/rules/ts.md`
const SUB_CLAUDE = `${CWD}/sub/CLAUDE.md`
const SKILL_DIR = `${CWD}/.claude/skills/demo`
const CLAUDE_TEXT = '# Fixture project instructions\nThis is the ccfiles fixture repo. Keep answers short.\n@docs/style.md\n'
const STYLE_TEXT = '# Style guide (imported from CLAUDE.md)\n- Use two-space indentation.\n- Prefer named exports.\n'
const LISTING =
  'The following skills are available for use with the Skill tool:\n\n' +
  '- demo: Demo skill for the ccfiles fixture. Use when the user says "run the demo skill".\n' +
  '- marketing:brand-review: Review content against your brand voice.'
const SKILL_TEXT = `Base directory for this skill: ${SKILL_DIR}\n\n# Demo skill\nWhen invoked, read \`reference.md\` in this skill's directory (lines 1-200 only) and summarize it in one line.\n`

const FILES = [
  { path: CLAUDE, kind: 'project', content: CLAUDE_TEXT },
  { path: STYLE, kind: 'project', content: STYLE_TEXT, parent: CLAUDE },
  { path: MEMORY, kind: 'memory', content: MEMORY_LOADED },
]

/** Claude Code beneath the mod: echoes context/attachments/skill text; optionally adds files (as the agents-md mod does). */
function engine(on: On, addToContext: { path: string; kind: string; content: string }[] = []) {
  on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: [...(e.instructionFiles ?? []), ...addToContext] }) as never)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
}

async function sessionStartLoads($: Engine, files = FILES) {
  await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'session_start' } as never)
  await $.classic.InstructionsLoaded({ file_path: STYLE, memory_type: 'Project', load_reason: 'include', parent_file_path: CLAUDE } as never)
  await $.prompt.context({ blocks: [{ name: 'claudeMd', text: '...' }], instructionFiles: files } as never)
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
}

const FILES_WITH_LOG = (log: string) => ({ [LOG]: log })
const nested = (path: string, content: string) => ({ type: 'nested_memory', text: `Contents of ${path}:\n\n${content}`, origin: { kind: 'engine' } })

describe('session start', () => {
  test('lists CLAUDE.md, the docs/style.md import with its parent, capped MEMORY.md and the demo skill description, all auto-loaded', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const s = h.state()
    const g = instructionGroups(s)
    expect(g.auto.map((f) => f.path)).toEqual([CLAUDE, STYLE, MEMORY])
    for (const f of g.auto) expect(f.instruction?.mode).toBe('auto')

    expect(s.files.get(CLAUDE)!.instruction).toMatchObject({ loads: 1, loadReasons: ['session_start'], origin: 'project' })
    expect(s.files.get(CLAUDE)!.estTokens).toBe(Math.ceil(CLAUDE_TEXT.length / 4))
    expect(s.files.get(STYLE)!.instruction).toMatchObject({ parentPath: CLAUDE, loadReasons: ['include'] })

    const mem = s.files.get(MEMORY)!
    expect(mem.coverage).toBe('capped')
    expect(mem.instruction).toMatchObject({ origin: 'memory', capped: true })
    expect(rangeSummary(mem)).toBe('1–200 / 260')
    expect(coveragePercent(mem)).toBe(77)
    expect(mem.estTokens).toBe(Math.ceil(MEMORY_LOADED.length / 4))

    expect(g.skills.get('demo')?.map((f) => f.path)).toEqual(['skill-description:demo'])
    expect(s.files.get('skill-description:demo')!.estTokens).toBeGreaterThan(0)
    expect(s.files.get('skill-description:marketing:brand-review')!.owner).toEqual({ kind: 'plugin', name: 'marketing' })
  })

  test('AGENTS.md added by another mod (only in the prompt.context result) is listed as agents-md', async ($, on) => {
    const h = harness(on)
    engine(on, [{ path: AGENTS, kind: 'project', content: '# AGENTS.md (fixture)\nAgents: prefer small diffs.\n' }])
    await startSession($)
    await $.prompt.context({ blocks: [], instructionFiles: [FILES[2]!] } as never)
    await endSession($)
    expect(h.state().files.get(AGENTS)!.instruction).toMatchObject({ mode: 'auto', loadReasons: ['agents-md'] })
  })
})

describe('loads triggered by reads', () => {
  test('rules/ts.md (paths:) is absent at startup and loads only on the sub/a.ts read; the globs: control rule loads at startup', async ($, on) => {
    const h = harness(on)
    const control = `${CWD}/.claude/rules/globs-control.md`
    const controlText = '# Control rule (globs: front matter, loads unscoped)\nThis rule is the globs control and applies everywhere.\n'
    engine(on)
    const t = tools(on)
    await startSession($)
    // As Claude Code 2.1.295 reports it: the control rule is a session-start file.
    await sessionStartLoads($, [...FILES, { path: control, kind: 'project', content: controlText }])
    await endSession($)
    const atStart = h.state()
    expect(atStart.files.has(RULE)).toBe(false)
    expect(atStart.files.get(control)!.instruction).toMatchObject({ mode: 'auto', loads: 1, loadReasons: ['session_start'] })

    await t.call($, { tool: 'Read', file_path: `${CWD}/sub/a.ts` }, readResult(`${CWD}/sub/a.ts`, SUB_A))
    await $.classic.InstructionsLoaded({ file_path: RULE, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['**/*.ts'], trigger_file_path: `${CWD}/sub/a.ts` } as never)
    await $.prompt.attachment(nested(RULE, '# TypeScript rule (path-scoped)\nAlways use `const` over `let` in TypeScript files.\n') as never)
    await endSession($)
    const s = h.state()
    expect(s.files.get(RULE)!.instruction).toMatchObject({ loads: 1, loadReasons: ['path_glob_match'], triggerPath: `${CWD}/sub/a.ts` })
    expect(s.files.get(control)!.instruction?.loads).toBe(1)
  })

  test('reading sub/a.ts adds sub/CLAUDE.md (nested_traversal, trigger sub/a.ts) and rules/ts.md (path_glob_match)', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: `${CWD}/sub/a.ts` }, readResult(`${CWD}/sub/a.ts`, SUB_A))
    await $.classic.InstructionsLoaded({ file_path: SUB_CLAUDE, memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: `${CWD}/sub/a.ts` } as never)
    await $.prompt.attachment(nested(SUB_CLAUDE, '# sub/ instructions\nFiles in sub/ are examples; never modify them without asking.\n') as never)
    await $.classic.InstructionsLoaded({ file_path: RULE, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['**/*.ts'], trigger_file_path: `${CWD}/sub/a.ts` } as never)
    await $.prompt.attachment(nested(RULE, '# TypeScript rule (path-scoped)\nAlways use `const` over `let` in TypeScript files.\n') as never)
    await endSession($)
    const s = h.state()
    expect(s.files.get(SUB_CLAUDE)!.instruction).toMatchObject({ mode: 'auto', loads: 1, loadReasons: ['nested_traversal'], triggerPath: `${CWD}/sub/a.ts` })
    expect(s.files.get(SUB_CLAUDE)!.estTokens).toBeGreaterThan(0)
    expect(s.files.get(RULE)!.instruction).toMatchObject({ loads: 1, loadReasons: ['path_glob_match'], globs: ['**/*.ts'] })
    expect(instructionGroups(s).auto.map((f) => f.path)).toEqual([SUB_CLAUDE, RULE])
  })
})

describe('skills', () => {
  test('a project skill description row gets its path from a folder scan, marked ? via fallback (U-6); plugin skills are not scanned', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await endSession($)
    const s = h.state()
    const demo = s.files.get('skill-description:demo')!
    expect(demo.instruction?.resolvedPath).toBe(`${SKILL_DIR}/SKILL.md`)
    expect(demo.viaFallback).toContain('scanning skill folders')
    expect(unverifiedMark(demo)).toBe('?')
    const plugin = s.files.get('skill-description:marketing:brand-review')!
    expect(plugin.instruction?.resolvedPath).toBe(null)
    expect(plugin.viaFallback).toBe(null)
  })

  test('invoking demo shows SKILL.md loaded; reading reference.md 1–200 is read via tool, 33%, under the skill', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    await startSession($)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await $.skill.prompt({ skill: 'demo', text: SKILL_TEXT })
    const ref = `${SKILL_DIR}/reference.md`
    await t.call($, { tool: 'Read', file_path: ref, offset: 1, limit: 200 }, readResult(ref, REFERENCE, 1, 200))
    await endSession($)
    const s = h.state()
    expect(s.files.get(`${SKILL_DIR}/SKILL.md`)).toMatchObject({ lastAction: 'skillLoad', estTokens: Math.ceil(SKILL_TEXT.length / 4) })
    expect(s.files.get(`${SKILL_DIR}/SKILL.md`)!.instruction).toMatchObject({ mode: 'auto', loads: 1 })
    const r = s.files.get(ref)!
    expect(r.instruction?.mode).toBe('tool')
    expect(rangeSummary(r)).toBe('1–200 / 600')
    expect(coveragePercent(r)).toBe(33)
    expect(instructionGroups(s).skills.get('demo')?.map((f) => f.path)).toEqual(['skill-description:demo', `${SKILL_DIR}/SKILL.md`, ref])
  })
})

describe('/compact', () => {
  test('reloaded files are marked compact and counted again; restored reads count again', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    await startSession($)
    await sessionStartLoads($)
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await $.classic.InstructionsLoaded({ file_path: RULE, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['**/*.ts'], trigger_file_path: `${CWD}/small.ts` } as never)
    await $.prompt.attachment(nested(RULE, '# TypeScript rule\n') as never)
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null } as never)
    const before = h.state()
    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'compact' } as never)
    await $.classic.InstructionsLoaded({ file_path: STYLE, memory_type: 'Project', load_reason: 'include', parent_file_path: CLAUDE } as never)
    await $.prompt.context({ blocks: [], instructionFiles: FILES } as never)
    const restore = (path: string, body: string) => ({
      type: 'file',
      text: `Called the Read tool with the following input: {"file_path":"${path}"}\nResult of calling the Read tool:\n${body}`,
      origin: { kind: 'engine' },
    })
    await $.prompt.attachment(restore(RULE, '1\t---\n2\tpaths:\n3\t  - "**/*.ts"\n4\t---\n5\t# TypeScript rule\n6\t') as never)
    await $.prompt.attachment(restore(`${CWD}/small.ts`, SMALL.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')) as never)
    await endSession($)
    const s = h.state()

    expect(s.epoch).toBe(1)
    expect(s.files.get(CLAUDE)!.instruction).toMatchObject({ loads: 2, loadReasons: ['session_start', 'compact'] })
    expect(s.files.get(CLAUDE)!.estTokens).toBe(2 * before.files.get(CLAUDE)!.estTokens)
    expect(s.files.get(MEMORY)!.instruction).toMatchObject({ loads: 2, loadReasons: ['session_start', 'compact'] })
    expect(s.files.get(RULE)!.instruction).toMatchObject({ loads: 2, loadReasons: ['path_glob_match', 'compact'] })
    // The restore numbers the raw file (front matter included): its length wins over the stripped nested_memory text.
    expect(rangeSummary(s.files.get(RULE)!)).toBe('1–5 / 5')
    const small = s.files.get(`${CWD}/small.ts`)!
    expect(small.reads).toBe(2)
    expect(small.intervals).toEqual([[1, 40]])
    expect(small.history[1]).toMatchObject({ source: 'compactRestore', loadReason: 'compact' })
  })
})

describe('one length basis per instruction file', () => {
  const GLOBS = `${CWD}/.claude/rules/globs-control.md`
  const RAW = '---\nglobs: ["**/*.ts"]\n---\n# Control rule (globs: front matter, loads unscoped)\nThis rule is the globs control and applies everywhere.\n'
  const STRIPPED = '# Control rule (globs: front matter, loads unscoped)\nThis rule is the globs control and applies everywhere.\n'
  const RULE_RAW = '---\npaths:\n  - "**/*.ts"\n---\n# TypeScript rule\n'

  test('a whole instruction load counts the raw file (front matter stripped noted); a whole compact restore keeps it at 100%', async ($, on) => {
    const h = harness(on, { [GLOBS]: RAW, [RULE]: RULE_RAW })
    engine(on)
    const t = tools(on)
    await startSession($)
    await $.classic.InstructionsLoaded({ file_path: GLOBS, memory_type: 'Project', load_reason: 'session_start', globs: ['**/*.ts'] } as never)
    await $.prompt.context({ blocks: [], instructionFiles: [...FILES, { path: GLOBS, kind: 'project', content: STRIPPED }] } as never)
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await $.classic.InstructionsLoaded({ file_path: RULE, memory_type: 'Project', load_reason: 'path_glob_match', globs: ['**/*.ts'], trigger_file_path: `${CWD}/small.ts` } as never)
    await $.prompt.attachment(nested(RULE, '# TypeScript rule\n') as never)
    await endSession($)
    const before = h.state()
    for (const [path, raw, stripped] of [[GLOBS, 5, 2], [RULE, 5, 1]] as const) {
      const f = before.files.get(path)!
      expect(rangeSummary(f)).toBe(`1–${raw} / ${raw}`)
      expect(coveragePercent(f)).toBe(100)
      expect(f.coverage).toBe('full')
      expect(f.instruction!.strippedLines).toBe(stripped)
    }
    expect(detailLines(before.files.get(GLOBS)!, { root: CWD, home: null, git: null, themeHint: null }).map((l) => l.map((c) => c.text).join('')).join('\n')).toMatch(/loaded +2 lines \(front matter stripped/)

    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: GLOBS, memory_type: 'Project', load_reason: 'compact' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: [...FILES, { path: GLOBS, kind: 'project', content: STRIPPED }] } as never)
    const numbered = RAW.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')
    await $.prompt.attachment({ type: 'file', text: `Called the Read tool with the following input: {"file_path":"${GLOBS}"}\nResult of calling the Read tool:\n${numbered}`, origin: { kind: 'engine' } } as never)
    await endSession($)
    const g = h.state().files.get(GLOBS)!
    expect(rangeSummary(g)).toBe('1–5 / 5')
    expect(coveragePercent(g)).toBe(100)
    expect(g.coverage).toBe('full')
  })

  test('a file not readable on disk keeps the loaded length', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await $.prompt.context({ blocks: [], instructionFiles: [{ path: GLOBS, kind: 'project', content: STRIPPED }] } as never)
    await endSession($)
    const g = h.state().files.get(GLOBS)!
    expect(rangeSummary(g)).toBe('1–2 / 2')
    expect(g.instruction!.strippedLines).toBe(null)
  })
})

describe('/compact counts once per compaction', () => {
  const restore = (path: string, body: string) => ({
    type: 'file',
    text: `Called the Read tool with the following input: {"file_path":"${path}"}\nResult of calling the Read tool:\n${body}`,
    origin: { kind: 'engine' },
  })
  const numbered = (text: string) => text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')
  const compact = async ($: Engine, restores: (() => Promise<unknown>)[]) => {
    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'compact' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: FILES } as never)
    for (const r of restores) await r()
  }

  test('an instruction file on IL compact + prompt.context + a file attachment, and small.ts restored twice, each count once; a second compaction counts again', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    const small = `${CWD}/small.ts`
    await startSession($)
    await sessionStartLoads($)
    await t.call($, { tool: 'Read', file_path: small }, readResult(small, SMALL))
    const signals = [
      () => $.prompt.attachment(restore(CLAUDE, numbered(CLAUDE_TEXT)) as never),
      () => $.prompt.attachment(restore(small, numbered(SMALL)) as never),
      () => $.prompt.attachment(restore(small, numbered(SMALL)) as never),
    ]
    await compact($, signals)
    await endSession($)
    const once = h.state()
    const claude1 = once.files.get(CLAUDE)!
    expect(claude1.instruction).toMatchObject({ loads: 2, loadReasons: ['session_start', 'compact'] })
    expect(claude1.estTokens).toBe(2 * Math.ceil(CLAUDE_TEXT.length / 4))
    const small1 = once.files.get(small)!
    expect(small1.reads).toBe(2)
    expect(small1.reloads).toBe(1)
    expect(small1.lastReload).toMatchObject({ epoch: 1 })
    expect(claude1.reloads).toBe(1)

    await compact($, signals)
    await endSession($)
    const twice = h.state()
    expect(twice.files.get(CLAUDE)!.instruction?.loads).toBe(3)
    expect(twice.files.get(small)!.reads).toBe(3)
    expect(twice.files.get(small)!.estTokens).toBe(small1.estTokens + (small1.estTokens - once.files.get(small)!.history[0]!.estTokens!))
    expect(twice.files.get(small)!.reloads).toBe(2)
  })

  test('a subagent loading a file first loaded in the same epoch is not a reload', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: SUB_CLAUDE, memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: `${CWD}/sub/a.ts` } as never)
    await $.classic.InstructionsLoaded({ file_path: SUB_CLAUDE, memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: `${CWD}/sub/a.ts`, agent_id: 'a1', agent_type: 'Explore' } as never)
    await endSession($)
    expect(h.state().files.get(SUB_CLAUDE)!).toMatchObject({ reloads: 0 })
  })

  test('an InstructionsLoaded whose content never came does not swallow the next compaction\'s load', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await $.classic.InstructionsLoaded({ file_path: STYLE, memory_type: 'Project', load_reason: 'include', parent_file_path: CLAUDE } as never)
    await startSession($, 'compact')
    await $.prompt.context({ blocks: [], instructionFiles: [FILES[1]!] } as never)
    await endSession($)
    const f = h.state().files.get(STYLE)!
    expect(f.instruction).toMatchObject({ loads: 2, loadReasons: ['include', 'compact'] })
    expect(f.estTokens).toBe(Math.ceil(STYLE_TEXT.length / 4))
    expect(f.reloads).toBe(1)
  })
})

describe('/compact: selective re-injection', () => {
  const restore = (path: string, body: string) => ({
    type: 'file',
    text: `Called the Read tool with the following input: {"file_path":"${path}"}\nResult of calling the Read tool:\n${body}`,
    origin: { kind: 'engine' },
  })
  const numbered = (text: string, from = 1) => text.split('\n').map((l, i) => `${from + i}\t${l}`).join('\n')

  test('a re-injected file is a fresh load in context; one not re-injected keeps its history but leaves the in-context total until read again', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    const small = `${CWD}/small.ts`
    const big = `${CWD}/big.md`
    const BIG_TEXT = 'b\n'.repeat(1323)
    await startSession($)
    await sessionStartLoads($)
    await t.call($, { tool: 'Read', file_path: small }, readResult(small, SMALL))
    await t.call($, { tool: 'Read', file_path: big, offset: 150, limit: 51 }, readResult(big, BIG_TEXT, 150, 51))
    await endSession($)
    const before = h.state()
    expect(before.files.get(big)!).toMatchObject({ inContext: true, outOfContext: null })
    expect(totals(before).contextTokens).toBe(totals(before).readTokens)

    // Claude Code re-injects small.ts and CLAUDE.md, not big.md and not the skill listing.
    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'compact' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: FILES } as never)
    await $.prompt.attachment(restore(small, numbered(SMALL)) as never)
    await endSession($)
    const s = h.state()
    const sm = s.files.get(small)!
    const bg = s.files.get(big)!
    expect(sm).toMatchObject({ inContext: true, outOfContext: null, reloads: 1 })
    expect(sm.contextTokens).toBe(sm.history.at(-1)!.estTokens)
    expect(bg).toMatchObject({ inContext: false, contextTokens: 0, intervals: [[150, 200]], reads: 1 })
    expect(bg.outOfContext).toMatchObject({ epoch: 1 })
    expect(bg.estTokens).toBe(before.files.get(big)!.estTokens)
    expect(s.files.get(CLAUDE)!).toMatchObject({ inContext: true, outOfContext: null })
    // Skill descriptions stay in context: Claude Code re-sends the listing.
    const descriptions = ['skill-description:demo', 'skill-description:marketing:brand-review'].map((p) => s.files.get(p)!)
    for (const d of descriptions) expect(d).toMatchObject({ inContext: true, outOfContext: null })

    // Two totals: in context now (re-injected only) vs the cumulative session.
    const sum = totals(s)
    const inContext = [...s.files.values()].filter((f) => f.inContext).reduce((n, f) => n + f.contextTokens, 0)
    expect(sum.contextTokens).toBe(inContext)
    expect(sum.contextTokens).toBeLessThan(sum.readTokens)
    const carried = descriptions.reduce((n, d) => n + d.contextTokens, 0)
    expect(sum.readTokens).toBe(totals(before).readTokens + sm.contextTokens + s.files.get(CLAUDE)!.contextTokens + s.files.get(STYLE)!.contextTokens + s.files.get(MEMORY)!.contextTokens + carried)
    expect(footerLine(s)).toContain(`in context ${fmtEstTokens(sum.contextTokens)}`)
    expect(footerLine(s)).toContain(`loaded ∑ ${fmtEstTokens(sum.readTokens)}`)

    // A later read brings big.md back as a normal read.
    await t.call($, { tool: 'Read', file_path: big, offset: 150, limit: 51 }, readResult(big, BIG_TEXT, 150, 51))
    await endSession($)
    const back = h.state().files.get(big)!
    expect(back).toMatchObject({ inContext: true, outOfContext: null, reads: 2, rereads: 1 })
    expect(back.contextTokens).toBe(back.history.at(-1)!.estTokens)
  })

  test('the attributed share compares files in context now with the context size', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, model: 'm' } } as never
    })
    const big = `${CWD}/big.md`
    await startSession($)
    await t.call($, { tool: 'Read', file_path: big }, readResult(big, 'x'.repeat(39) + '\n'.repeat(1)))
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await startSession($, 'compact')
    await $.prompt.attachment(restore(`${CWD}/small.ts`, numbered(SMALL)) as never)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
    await endSession($)
    const s = h.state()
    const pct = Math.round((totals(s).contextTokens / 10_000) * 100)
    expect(footerLine(s)).toContain(`≈ attributed to files: ${pct}%`)
    expect(totals(s).contextTokens).toBe(s.files.get(`${CWD}/small.ts`)!.contextTokens)
  })
})

describe('skill descriptions after /compact', () => {
  const descriptions = (s: ReturnType<ReturnType<typeof harness>['state']>) =>
    [...s.files.values()].filter((f) => f.instruction?.origin === 'skillDescription')
  const inContext = (s: ReturnType<ReturnType<typeof harness>['state']>) => descriptions(s).reduce((n, f) => n + (f.inContext ? f.contextTokens : 0), 0)

  test('the descriptions stay counted in context in the new epoch, ⟳, once more in loaded ∑', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const before = h.state()
    const listed = inContext(before)
    expect(listed).toBeGreaterThan(0)
    await startSession($, 'compact')
    await endSession($)
    const s = h.state()
    expect(inContext(s)).toBe(listed)
    for (const d of descriptions(s)) {
      expect(d).toMatchObject({ inContext: true, outOfContext: null, reloads: 1 })
      expect(d.instruction).toMatchObject({ loads: 2, loadReasons: ['skill_listing', 'compact'] })
      expect(d.history.at(-1)).toMatchObject({ kind: 'autoload', source: 'compactRestore', loadReason: 'compact' })
    }
    expect(totals(s).readTokens).toBe(totals(before).readTokens + listed)
    expect(instructionSummaryLine(s)).toContain(`${fmtEstTokens(totals(s).instructionContextTokens)} in context`)
  })

  test('a listing re-sent in the new epoch counts once: no second load, in-context unchanged', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await startSession($, 'compact')
    await endSession($)
    const compacted = h.state()
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await endSession($)
    const s = h.state()
    expect(totals(s)).toEqual(totals(compacted))
    for (const d of descriptions(s)) expect(d.instruction!.loads).toBe(2)
    // A second compaction is a new epoch: the descriptions count again.
    await startSession($, 'compact')
    await endSession($)
    for (const d of descriptions(h.state())) expect(d.instruction!.loads).toBe(3)
    expect(inContext(h.state())).toBe(inContext(s))
  })

  // The re-sent listing is one fresh load in the new epoch, whichever arrives first.
  test('a listing that arrives before the compact event: still exactly one load per new epoch, counted once in loaded ∑', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const before = h.state()
    const listed = inContext(before)
    const listing = { type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never
    for (const [n, compactions] of [[2, 1], [3, 2]] as const) {
      await $.prompt.attachment(listing)
      await startSession($, 'compact')
      await $.prompt.attachment(listing)
      await endSession($)
      const s = h.state()
      for (const d of descriptions(s)) {
        expect(d).toMatchObject({ inContext: true, outOfContext: null, reloads: compactions })
        expect(d.instruction!.loads).toBe(n)
      }
      expect(inContext(s)).toBe(listed)
      expect(totals(s).readTokens).toBe(totals(before).readTokens + compactions * listed)
      expect(footerLine(s)).toContain(`loaded ∑ ${fmtEstTokens(totals(s).readTokens)}`)
      expect(footerLine(s)).toContain(`in context ${fmtEstTokens(totals(s).contextTokens)}`)
    }
  })

  test('the detail view shows a re-sent description as a compact re-load, like a re-injected file', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await startSession($, 'compact')
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await endSession($)
    const s = h.state()
    const d = descriptions(s)[0]!
    const text = detailLines(d, { root: CWD, home: null, git: null, themeHint: null, session: s }).map((l) => l.map((c) => c.text).join('')).join('\n')
    expect(text).toMatch(/loads +2 · skill_listing, compact/)
    expect(text).toContain('⟳ 1× after /compact')
    expect(text).toContain('compact, restored')
    expect(text).toContain('in context now')
    expect(text).not.toContain('out of context')
  })

  test("the engine fork's listing in the new epoch is still not counted for main", async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await startSession($, 'compact')
    await endSession($)
    const compacted = totals(h.state())
    // As of 2.1.295 an agent with no SubagentStart receives the listing.
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' }, agentId: 'afea40c9d1e2f3a4b' } as never)
    await endSession($)
    const s = h.state()
    expect(totals(s)).toEqual(compacted)
    expect(s.otherAgents.agents.has('afea40c9d1e2f3a4b')).toBe(true)
  })

  test('a new skill first listed after the compaction counts as a plain load', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await startSession($, 'compact')
    await $.prompt.attachment({ type: 'skill_listing', text: `${LISTING}\n- fresh: Installed after the compaction.`, origin: { kind: 'engine' } } as never)
    await endSession($)
    const fresh = h.state().files.get('skill-description:fresh')!
    expect(fresh).toMatchObject({ inContext: true, reloads: 0 })
    expect(fresh.instruction!.loads).toBe(1)
  })
})

describe('a skill restored after /compact (invoked_skills)', () => {
  test('SKILL.md is re-injected: back in context, ⟳, counted once per compaction even if the restore is re-sent', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await $.skill.prompt({ skill: 'demo', text: SKILL_TEXT } as never)
    await startSession($, 'compact')
    const restored = {
      type: 'invoked_skills',
      text: `The following skills were invoked EARLIER in this session (before the conversation was compacted), not on the current turn.\n\n### Skill: demo\n${SKILL_TEXT}`,
      origin: { kind: 'engine' },
    }
    await $.prompt.attachment(restored as never)
    await $.prompt.attachment(restored as never)
    await endSession($)
    const f = h.state().files.get(`${SKILL_DIR}/SKILL.md`)!
    expect(f).toMatchObject({ inContext: true, outOfContext: null, reloads: 1 })
    expect(f.instruction!.loads).toBe(2)
    expect(f.instruction!.loadReasons).toEqual(['skill_invoked', 'compact'])
    expect(f.contextTokens).toBeGreaterThan(0)
    expect(f.owner).toMatchObject({ kind: 'skill', name: 'demo' })
  })
})

describe("Claude Code's internal agents", () => {
  test('a skill listing from an agent with no SubagentStart (an internal fork) stays in history but is left out of the file totals, shown as other agents', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const before = totals(h.state())
    // ~3 s after a main turn, a fork with no SubagentStart gets the skill listing; it ends with an empty agent_type.
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' }, agentId: 'a43f01437f9ffbb5e' } as never)
    await $.classic.SubagentStop({ agent_id: 'a43f01437f9ffbb5e', agent_type: '', last_assistant_message: null } as never)
    await endSession($)
    const s = h.state()
    expect(totals(s).readTokens).toBe(before.readTokens)
    expect(totals(s).instructionTokens).toBe(before.instructionTokens)
    const demo = s.files.get('skill-description:demo')!
    expect(demo.instruction!.loads).toBe(1)
    expect(demo.history.map((e) => e.agentId)).toEqual([null, 'a43f01437f9ffbb5e'])
    expect(s.otherAgents.agents.has('a43f01437f9ffbb5e')).toBe(true)
    expect(s.otherAgents.estTokens).toBe(demo.history[1]!.estTokens! + s.files.get('skill-description:marketing:brand-review')!.history[1]!.estTokens!)
    expect(s.internalAgents.has('a43f01437f9ffbb5e')).toBe(true)
    expect(footerLine(s)).toContain(`other agents ${fmtEstTokens(s.otherAgents.estTokens)}`)
  })

  test('a user-visible subagent (SubagentStart with a type) still counts its own loads', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await $.classic.SubagentStart({ agent_id: 'a0ccdd61e74e15cd4', agent_type: 'Explore' } as never)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' }, agentId: 'a0ccdd61e74e15cd4' } as never)
    await endSession($)
    const s = h.state()
    expect(s.files.get('skill-description:demo')!.instruction!.loads).toBe(2)
    expect(s.otherAgents.estTokens).toBe(0)
  })
})

describe('unverified detections and totals', () => {
  test('main fixture (root CLAUDE.md) → AGENTS.md not loaded, no tokens; totals consistent', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const s = h.state()
    expect(s.files.has(AGENTS)).toBe(false)
    const sum = totals(s)
    expect(sum.readTokens).toBe(sum.instructionTokens)
    expect(instructionSummaryLine(s)).toContain(`of ${fmtEstTokens(sum.readTokens)} read`)
  })

  test('agents-only fixture → AGENTS.md loaded from the prompt.context result with ?, via fallback, never from InstructionsLoaded', async ($, on) => {
    const h = harness(on)
    const agentsText = '# AGENTS.md (fixture)\nAgents: prefer small diffs.\n'
    engine(on, [{ path: AGENTS, kind: 'project', content: agentsText }])
    await startSession($)
    // No root CLAUDE.md: the engine's input lists only MEMORY.md; the built-in agents-md mod adds AGENTS.md beneath.
    await $.prompt.context({ blocks: [], instructionFiles: [FILES[2]!] } as never)
    await endSession($)
    const s = h.state()
    const f = s.files.get(AGENTS)!
    expect(f.instruction).toMatchObject({ mode: 'auto', loads: 1 })
    expect(f.estTokens).toBe(Math.ceil(agentsText.length / 4))
    expect(unverifiedMark(f)).toBe('?')
    expect(f.viaFallback).toContain('AGENTS.md')
    expect(f.history.some((e) => e.source === 'instructionsLoaded')).toBe(false)
    const sum = totals(s)
    expect(sum.instructionTokens).toBe(f.estTokens + s.files.get(MEMORY)!.estTokens)
    expect(sum.readTokens).toBe(sum.instructionTokens)
  })

  test('MEMORY.md (U-4) is recorded as detected via fallback; CLAUDE.md is not', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const s = h.state()
    expect(s.files.get(MEMORY)!.viaFallback).toContain('prompt.context')
    expect(s.files.get(CLAUDE)!.viaFallback).toBe(null)
  })

  test('a detection on an unconfirmed path shows ?, confirmed ones do not', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    await startSession($)
    await sessionStartLoads($)
    await t.call($, { tool: 'Grep', pattern: 'x', path: CWD }, { ref: 1, result: { mode: 'files_with_matches', numFiles: 1, filenames: ['big.md'] }, text: 'Found 1 file\nbig.md' })
    await $.skill.prompt({ skill: 'mystery', text: '# no base directory line\n' })
    await endSession($)
    const s = h.state()
    expect(unverifiedMark(s.files.get(`${CWD}/big.md`)!)).toBe('?')
    expect(unverifiedMark(s.files.get('skill:mystery/SKILL.md')!)).toBe('?')
    expect(unverifiedMark(s.files.get(CLAUDE)!)).toBe('')
    expect(unverifiedMark(s.files.get(MEMORY)!)).toBe('')
  })

  test('the tab summary equals the sum of its rows and fits within the footer total', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    await startSession($)
    await sessionStartLoads($)
    await $.skill.prompt({ skill: 'demo', text: SKILL_TEXT })
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await endSession($)
    const s = h.state()
    const g = instructionGroups(s)
    const rows = [...g.auto, ...[...g.skills.values()].flat(), ...g.other]
    const sum = totals(s)
    expect(sum.instructionTokens).toBe(rows.reduce((n, f) => n + f.estTokens, 0))
    expect(sum.readTokens).toBe([...s.files.values()].reduce((n, f) => n + f.estTokens, 0))
    expect(sum.readTokens).toBe(sum.instructionTokens + s.files.get(`${CWD}/small.ts`)!.estTokens)
    expect(instructionSummaryLine(s)).toMatch(/^3 auto · 1 skills · ≈\S+ tok of ≈\S+ tok read$/)
  })
})

describe('tokens', () => {
  test('exact API usage: the latest main context and session output, labeled exact; no figure is unmarked', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    const usages = [
      { input_tokens: 2, output_tokens: 155, cache_read_input_tokens: 25283, cache_creation_input_tokens: 22477, model: 'claude-opus-5-5' },
      { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 47760, cache_creation_input_tokens: 500, model: 'claude-opus-5-5' },
    ]
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usages[e.index] } as never
    })
    await startSession($)
    await sessionStartLoads($)
    for (const index of [0, 1]) {
      const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 })
      for await (const _ of stream) void _
      await stream.result
    }
    await t.call($, { tool: 'Write', file_path: `${CWD}/out.ts`, content: 'x\n'.repeat(100) }, { ref: 1, result: { type: 'create', filePath: `${CWD}/out.ts`, content: 'x\n'.repeat(100), structuredPatch: [], originalFile: null }, text: 'ok' })
    await endSession($)
    const s = h.state()
    expect(s.usage).toEqual({ requests: 2, input: 5, output: 195, cacheRead: 73043, cacheCreation: 22977 })
    const footer = footerLine(s)
    // The latest main request's context (3 + 47,760 + 500), not a sum that re-counts cached context.
    expect(s.latestContext).toBe(48_263)
    expect(footer).toContain('context =48k')
    expect(footer).toContain('out =195')
    expect(footer).toContain('billed ∑ =96k incl. cache re-reads')
    expect(footer).not.toContain('API in')
    expect(footer).toMatch(/≈ attributed to files: \d+%/)
    expect(footer).toMatch(/written ≈\d+ tok/)
    expect(unmarkedTokenFigures(footer)).toEqual([])
    expect(unmarkedTokenFigures(instructionSummaryLine(s))).toEqual([])
    // The written payload is not part of the file cost.
    expect(s.files.get(`${CWD}/out.ts`)!.estTokens).toBe(0)
    expect(totals(s).readTokens).toBe(totals(s).instructionTokens)
  })
})

describe('persistence and resume', () => {
  test('the compaction marker is written at once, so a module reload right after /compact keeps the epoch', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null } as never)
    await startSession($, 'compact')
    expect(h.records().some((r) => r.t === 'event' && r.e.kind === 'compact')).toBe(true)
  })

  test('the log is written next to the transcript', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    expect([...h.written.keys()]).toEqual([LOG])
  })

  test('--resume restores coverage, instruction rows and token numbers, then keeps adding', async ($, on) => {
    const big = `${CWD}/big.md`
    const previous = serializeLog([
      { t: 'event', e: makeEvent({ ts: 1, kind: 'read', tool: 'Read', path: big, source: 'tool', ranges: [[1, 200]], totalLines: 1323, estTokens: 3845 }) },
      { t: 'event', e: makeEvent({ ts: 2, kind: 'autoload', path: CLAUDE, source: 'promptContext', whole: true, totalLines: 3, estTokens: 30, origin: 'project', loadReason: 'session_start' }) },
      { t: 'usage', ts: 3, agentId: null, model: 'm', usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
    ])
    const h = harness(on, { [LOG]: previous, [big]: 'x\n' })
    engine(on)
    const t = tools(on)
    await startSession($, 'resume')
    // The resumed process announces the same session-start file again: not a new load.
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'session_start' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: [{ path: CLAUDE, kind: 'project', content: 'y'.repeat(120) }] } as never)
    await t.call($, { tool: 'Read', file_path: big, offset: 150, limit: 200 }, readResult(big, 'l\n'.repeat(1323), 150, 200))
    await endSession($)
    const s = h.state()
    expect(rangeSummary(s.files.get(big)!)).toBe('1–349 / 1,323')
    expect(s.files.get(big)!.reads).toBe(2)
    expect(s.files.get(CLAUDE)!.instruction).toMatchObject({ loads: 1, mode: 'auto' })
    expect(s.files.get(CLAUDE)!.estTokens).toBe(30)
    expect(s.usage.output).toBe(10)
  })

  test('--resume after /compact: restored totals equal the totals before quitting; resumed signals add nothing', async ($, on) => {
    const h = harness(on)
    engine(on)
    const t = tools(on)
    const small = `${CWD}/small.ts`
    const big = `${CWD}/big.md`
    const restore = { type: 'file', text: `Called the Read tool with the following input: {"file_path":"${small}"}\nResult of calling the Read tool:\n${SMALL.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')}`, origin: { kind: 'engine' } }
    await startSession($)
    await sessionStartLoads($)
    await t.call($, { tool: 'Read', file_path: small }, readResult(small, SMALL))
    await t.call($, { tool: 'Read', file_path: big, offset: 1, limit: 20 }, readResult(big, 'b\n'.repeat(1323), 1, 20))
    // /compact: Claude Code re-injects CLAUDE.md, the session-start files and small.ts, not big.md or the skill listing.
    await startSession($, 'compact')
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'compact' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: FILES } as never)
    await $.prompt.attachment(restore as never)
    await endSession($)
    const quit = h.state()
    const before = totals(quit)

    // claude --resume: a new process replays the log, then Claude Code re-announces the same files and restores.
    await startSession($, 'resume')
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'session_start' } as never)
    await $.classic.InstructionsLoaded({ file_path: STYLE, memory_type: 'Project', load_reason: 'include', parent_file_path: CLAUDE } as never)
    await $.prompt.context({ blocks: [], instructionFiles: FILES } as never)
    await $.prompt.attachment(restore as never)
    await endSession($)
    const resumed = h.state()
    const after = totals(resumed)
    expect(after.instructionTokens).toBe(before.instructionTokens)
    expect(after.instructionContextTokens).toBe(before.instructionContextTokens)
    expect(after.readTokens - after.instructionTokens).toBe(before.readTokens - before.instructionTokens)
    expect(after.contextTokens).toBe(before.contextTokens)
    expect(resumed.files.get(CLAUDE)!.instruction!.loads).toBe(2)
    expect(resumed.files.get(small)!.reads).toBe(2)
    expect(resumed.files.get(big)!.outOfContext).toMatchObject({ epoch: 1 })

    // The first post-resume prompt carries the skill listing again. The descriptions stayed in context through the
    // compaction, already counted for this epoch: the re-sent listing changes no total.
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)
    await endSession($)
    const listed = h.state()
    const demo = listed.files.get('skill-description:demo')!
    expect(demo).toMatchObject({ inContext: true, outOfContext: null, reloads: 1 })
    expect(demo.instruction!.loads).toBe(2)
    expect(totals(listed)).toEqual(after)
  })

  test('--resume without a compaction: a skill listing re-sent in the same epoch is a re-send (no count)', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await endSession($)
    const before = totals(h.state())
    await startSession($, 'resume')
    await sessionStartLoads($)
    await endSession($)
    const s = h.state()
    expect(totals(s)).toEqual(before)
    expect(s.files.get('skill-description:demo')!.instruction!.loads).toBe(1)
  })

  test('without a SessionStart (a reloaded module), the first event naming the transcript adopts the existing log instead of overwriting it', async ($, on) => {
    const big = `${CWD}/big.md`
    const previous = serializeLog([
      { t: 'event', e: makeEvent({ ts: 1, kind: 'read', tool: 'Read', path: big, source: 'tool', ranges: [[1, 200]], totalLines: 1323, estTokens: 3845 }) },
    ])
    const h = harness(on, { ...FILES_WITH_LOG(previous) })
    engine(on)
    await $.classic.InstructionsLoaded({ file_path: CLAUDE, memory_type: 'Project', load_reason: 'session_start', transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl' } as never)
    await $.prompt.context({ blocks: [], instructionFiles: [FILES[0]!] } as never)
    await endSession($)
    const s = h.state()
    expect(rangeSummary(s.files.get(big)!)).toBe('1–200 / 1,323')
    expect(s.files.get(CLAUDE)!.instruction?.loads).toBe(1)
  })

  test('a module reloaded mid-turn adopts the log at the next prompt (UserPromptSubmit) or turn end (Stop), with no InstructionsLoaded', async ($, on) => {
    const big = `${CWD}/big.md`
    const small = `${CWD}/small.ts`
    const previous = serializeLog([
      { t: 'event', e: makeEvent({ ts: 1, kind: 'read', tool: 'Read', path: big, source: 'tool', ranges: [[1, 200]], totalLines: 1323, estTokens: 3845 }) },
    ])
    const h = harness(on, FILES_WITH_LOG(previous))
    engine(on)
    const t = tools(on)
    await t.call($, { tool: 'Read', file_path: small }, readResult(small, SMALL))
    await $.classic.UserPromptSubmit({ prompt: 'ok', transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl' } as never)
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl' } as never)
    await endSession($)
    const s = h.state()
    expect(rangeSummary(s.files.get(big)!)).toBe('1–200 / 1,323')
    expect(s.files.get(small)!.reads).toBe(1)
  })

  test('/clear starts an empty view under the new session', async ($, on) => {
    const h = harness(on)
    engine(on)
    await startSession($)
    await sessionStartLoads($)
    await $.classic.SessionStart({ source: 'clear', transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s2.jsonl', cwd: CWD } as never)
    await endSession($)
    expect(h.written.get('/home/u/.claude/projects/-tmp-ccfiles/s2/ccfiles/log.jsonl')).toBe(undefined)
    expect(h.state().files.size).toBeGreaterThan(0)
  })
})

describe('observe only: prompt, context and skill hooks', () => {
  test('prompt.context, prompt.attachment and skill.prompt answers pass through unchanged', async ($, on) => {
    harness(on)
    engine(on, [{ path: AGENTS, kind: 'project', content: 'a' }])
    await startSession($)
    const ctx = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'c' }], instructionFiles: FILES } as never)
    // The engine re-renders the claudeMd block from the file list; the list is what the mod must not touch.
    expect(ctx.instructionFiles).toEqual([...FILES, { path: AGENTS, kind: 'project', content: 'a' }])
    expect(await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never)).toEqual({ text: LISTING })
    expect(await $.skill.prompt({ skill: 'demo', text: SKILL_TEXT })).toEqual({ text: SKILL_TEXT })
  })

  test('selection-as-context is off by default: prompt.submit is untouched', async ($, on) => {
    harness(on)
    on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
    const r = await $.prompt.submit({ text: 'explain this', wait: false } as never)
    expect(r).toEqual({ text: 'explain this', context: undefined })
  })
})
