import { describe, expect, test } from 'claude-code/testing'
import { serializeLog } from '../src/log.ts'
import { coveragePercent, rangeSummary } from '../src/summary.ts'
import { BIG, CWD, FILES, LOG, SMALL, SUB_A, bashResult, endSession, harness, readResult, startSession, tools } from './harness.ts'

const BIG_PATH = `${CWD}/big.md`
const SMALL_PATH = `${CWD}/small.ts`

describe('Read', () => {
  test('Read big.md offset 1 limit 200 → 1–200 / 1,323, about 15%', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await endSession($)
    const f = h.state().files.get(BIG_PATH)!
    expect(rangeSummary(f)).toBe('1–200 / 1,323')
    expect(coveragePercent(f)).toBe(15)
    expect(f.verified).toBe(true)
  })

  test('then offset 150 limit 200 → 1–349 (26%), reads = 2, re-read flagged', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 150, limit: 200 }, readResult(BIG_PATH, BIG, 150, 200))
    await endSession($)
    const f = h.state().files.get(BIG_PATH)!
    expect(rangeSummary(f)).toBe('1–349 / 1,323')
    expect(coveragePercent(f)).toBe(26)
    expect(f.reads).toBe(2)
    expect(f.rereads).toBe(1)
  })

  test('small.ts whole → full; a PARTIAL view covers only the lines returned', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await t.call($, { tool: 'Read', file_path: BIG_PATH }, readResult(BIG_PATH, BIG, 1, 603, true))
    await endSession($)
    const s = h.state()
    expect(s.files.get(SMALL_PATH)).toMatchObject({ coverage: 'full', totalLines: 40, intervals: [[1, 40]] })
    const big = s.files.get(BIG_PATH)!
    expect(rangeSummary(big)).toBe('1–603 / 1,323')
    expect(big.coverage).toBe('partial')
    expect(big.history[0]?.truncated).toBe(true)
  })

  test("a file_unchanged stub (already in context) counts its ≈tokens but is not a re-read", async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    const stub = { ref: 1, result: { type: 'file_unchanged', file: { filePath: SMALL_PATH } }, text: 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.' }
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, stub)
    await endSession($)
    const f = h.state().files.get(SMALL_PATH)!
    expect(f).toMatchObject({ reads: 1, rereads: 0, stubs: 1, intervals: [[1, 40]], coverage: 'full' })
    expect(f.estTokens).toBe(f.history[0]!.estTokens! + Math.ceil(stub.text.length / 4))
    expect(f.history[1]).toMatchObject({ kind: 'read', stub: true, ranges: [] })
  })

  test('the estimate is chars ÷ 4 of the text Claude received', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    const answer = readResult(BIG_PATH, BIG, 1, 200)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, answer)
    await endSession($)
    expect(h.state().files.get(BIG_PATH)!.estTokens).toBe(Math.ceil(answer.text.length / 4))
  })

  test('without file access the total is assumed newline-terminated and marked unverified', async ($, on) => {
    const h = harness(on, {})
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    await endSession($)
    const f = h.state().files.get(BIG_PATH)!
    expect(f.totalLines).toBe(1323)
    expect(f.verified).toBe(false)
  })
})

describe('Bash', () => {
  test("sed -n '10,20p' adds 10–20; head -n 50 adds 1–50; sed '/a/,/b/p' is partial-unknown", async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    const lines = (a: number, b: number) => BIG.split('\n').slice(a - 1, b).join('\n')
    await startSession($)
    await t.call($, { tool: 'Bash', command: "sed -n '10,20p' /tmp/fv/big.md" }, bashResult(lines(10, 20)))
    await t.call($, { tool: 'Bash', command: 'head -n 50 small.ts' }, bashResult(SMALL.trimEnd()))
    await t.call($, { tool: 'Bash', command: "sed '/line 5:/,/line 9:/p' sub/a.ts" }, bashResult('x'))
    await endSession($)
    const s = h.state()
    expect(s.files.get(BIG_PATH)!.intervals).toEqual([[10, 20]])
    expect(s.files.get(BIG_PATH)!.history[0]?.tool).toBe('Bash:sed')
    expect(s.files.get(SMALL_PATH)).toMatchObject({ intervals: [[1, 40]], coverage: 'full' })
    expect(s.files.get(`${CWD}/sub/a.ts`)!.coverage).toBe('partial-unknown')
  })

  test('head -n 50 on big.md adds 1–50', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'head -n 50 big.md' }, bashResult(BIG.split('\n').slice(0, 50).join('\n')))
    await endSession($)
    expect(h.state().files.get(BIG_PATH)!.intervals).toEqual([[1, 50]])
  })

  test('head -n 5 on a longer file looks up its length, so the fill and % are known', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'head -n 5 sub/a.ts' }, bashResult(SUB_A.split('\n').slice(0, 5).join('\n')))
    await endSession($)
    expect(rangeSummary(h.state().files.get(`${CWD}/sub/a.ts`)!)).toBe('1–5 / 20')
  })

  test('tail looks up the file length to place the lines', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'tail -n 3 big.md' }, bashResult(BIG.trimEnd().split('\n').slice(-3).join('\n')))
    await endSession($)
    expect(rangeSummary(h.state().files.get(BIG_PATH)!)).toBe('1,321–1,323 / 1,323')
  })

  test('a grep -rn hit marks the file as a search hit with no coverage change', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200))
    const stdout =
      '.claude/skills/demo/reference.md:77:reference.md line 77: demo skill reference material.\nbig.md:77:big.md line 77: lorem ipsum dolor sit amet, consectetur adipiscing elit.'
    await t.call($, { tool: 'Bash', command: "grep -rn 'line 77:' ." }, bashResult(stdout))
    await endSession($)
    const s = h.state()
    const big = s.files.get(BIG_PATH)!
    expect(big.hits).toBe(1)
    expect(big.intervals).toEqual([[1, 200]])
    expect(big.lastAction).toBe('hit')
    const ref = s.files.get(`${CWD}/.claude/skills/demo/reference.md`)!
    expect(ref).toMatchObject({ coverage: 'hit', intervals: [], estTokens: 0 })
  })
})

describe('Bash keeps cd between calls (open question 2)', () => {
  const SUB_A_PATH = `${CWD}/sub/a.ts`
  const head3 = bashResult(SUB_A.split('\n').slice(0, 3).join('\n'))
  const done = bashResult('')
  const pathsRead = (s: ReturnType<ReturnType<typeof harness>['state']>) => s.events.filter((e) => e.kind === 'read').map((e) => [e.path, e.verified])

  test('a standalone cd moves later relative paths (cd sub then head -n 3 a.ts reads sub/a.ts)', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd sub' }, done)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[SUB_A_PATH, true]])
    expect(h.state().files.get(SUB_A_PATH)!.intervals).toEqual([[1, 3]])
  })

  test('cd X && … and cd X; … keep X for the next call', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd sub && head -n 3 a.ts' }, head3)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await t.call($, { tool: 'Bash', command: 'cd ..; head -n 3 sub/a.ts' }, head3)
    await t.call($, { tool: 'Bash', command: 'head -n 3 sub/a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[SUB_A_PATH, true], [SUB_A_PATH, true], [SUB_A_PATH, true], [SUB_A_PATH, true]])
  })

  test('cd alone and cd ~ go home; cd - makes the directory unknown (?)', async ($, on) => {
    const h = harness(on, { ...FILES, '/home/u/notes.md': 'n\n' })
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd' }, done)
    await t.call($, { tool: 'Bash', command: 'head -n 1 notes.md' }, bashResult('n'))
    await t.call($, { tool: 'Bash', command: 'cd /tmp/fv/sub' }, done)
    await t.call($, { tool: 'Bash', command: 'cd ~ && head -n 1 notes.md' }, bashResult('n'))
    await t.call($, { tool: 'Bash', command: 'cd -' }, bashResult('/tmp/fv/sub'))
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    const reads = h.state().events.filter((e) => e.kind === 'read')
    expect(reads.map((e) => e.path)).toEqual(['/home/u/notes.md', '/home/u/notes.md', expect.any(String)])
    expect(reads.map((e) => e.verified)).toEqual([true, true, false])
  })

  test('after cd -, a relative cd keeps the directory unknown; an absolute one makes it known again', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd -' }, done)
    await t.call($, { tool: 'Bash', command: 'cd sub' }, done)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await t.call($, { tool: 'Bash', command: 'cd /tmp/fv/sub' }, done)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state()).map(([, v]) => v)).toEqual([false, true])
  })

  test('cd "$UNSET_VAR" then cat a.ts → recorded with ? and via fallback, never on a guessed path', async ($, on) => {
    const h = harness(on, { ...FILES, [`${CWD}/a.ts`]: 'decoy\n' })
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd "$UNSET_VAR"' }, done)
    await t.call($, { tool: 'Bash', command: 'cat a.ts' }, bashResult(SUB_A))
    await endSession($)
    const s = h.state()
    const reads = s.events.filter((e) => e.kind === 'read')
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ verified: false, viaFallback: true })
    expect(reads[0]!.fallbackNote).toContain('directory unknown')
    // Neither the old directory's a.ts nor sub/a.ts gets the read.
    expect(s.files.get(`${CWD}/a.ts`)).toBe(undefined)
    expect(s.files.get(SUB_A_PATH)).toBe(undefined)
    expect(reads[0]!.path).not.toMatch(/^\//)
    expect(s.files.get(reads[0]!.path)!.viaFallback).toContain('directory unknown')
  })

  test('cd into a $VAR, a `cmd` substitution or a glob is unknown; an absolute cd afterwards is known again', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    for (const cd of ['cd $HOME_DIR/x', 'cd "$(git rev-parse --show-toplevel)"', 'cd `pwd`/sub', 'cd su*']) {
      await t.call($, { tool: 'Bash', command: 'cd /tmp/fv' }, done)
      await t.call($, { tool: 'Bash', command: cd }, done)
      await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    }
    await t.call($, { tool: 'Bash', command: 'cd /tmp/fv/sub' }, done)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([...Array(4).fill([expect.stringMatching(/^unresolved:/), false]), [SUB_A_PATH, true]])
  })

  test('"Shell cwd was reset to <dir>" in the result wins', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd /opt && ls' }, { ...bashResult('x'), text: 'x\nShell cwd was reset to /tmp/fv/sub' })
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[SUB_A_PATH, true]])
  })

  test('a resolved path that does not exist is marked ? (unverified)', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[`${CWD}/a.ts`, false]])
  })

  test("a subagent's cd doesn't move the main shell, and a failed cd moves nothing", async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd sub', agentId: 'a1' }, done)
    await t.call($, { tool: 'Bash', command: 'cd nowhere' }, { ...bashResult(''), isError: true, text: 'cd: nowhere: No such file or directory' })
    await t.call($, { tool: 'Bash', command: 'head -n 3 sub/a.ts' }, head3)
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts', agentId: 'a1' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[SUB_A_PATH, true], [SUB_A_PATH, true]])
  })

  test('--resume keeps the shell cwd from the log', async ($, on) => {
    const previous = serializeLog([{ t: 'shell', ts: 1, agentId: null, cwd: `${CWD}/sub` }])
    const h = harness(on, { ...FILES, [LOG]: previous })
    const t = tools(on)
    await startSession($, 'resume')
    await t.call($, { tool: 'Bash', command: 'head -n 3 a.ts' }, head3)
    await endSession($)
    expect(pathsRead(h.state())).toEqual([[SUB_A_PATH, true]])
  })

  test('the shell cwd is persisted in the log', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'cd sub' }, done)
    await endSession($)
    expect(h.records().filter((r) => r.t === 'shell')).toEqual([{ t: 'shell', ts: expect.any(Number), agentId: null, cwd: `${CWD}/sub` }])
  })
})

describe('Edit and Write', () => {
  test('Edit 3 lines → 5 gives +5 −3 and shifts later intervals by +2', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 20 }, readResult(BIG_PATH, BIG, 1, 20))
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 100, limit: 101 }, readResult(BIG_PATH, BIG, 100, 101))
    const oldLines = ['big.md line 50: a', 'big.md line 51: b', 'big.md line 52: c']
    const newLines = ['n1', 'n2', 'n3', 'n4', 'n5']
    const edit = {
      ref: 1,
      result: {
        filePath: BIG_PATH, oldString: oldLines.join('\n'), newString: newLines.join('\n'), originalFile: BIG, userModified: false, replaceAll: false,
        structuredPatch: [{ oldStart: 47, oldLines: 9, newStart: 47, newLines: 11, lines: [' 47', ' 48', ' 49', ...oldLines.map((l) => '-' + l), ...newLines.map((l) => '+' + l), ' 53', ' 54', ' 55'] }],
      },
      text: 'The file has been updated.',
    }
    await t.call($, { tool: 'Edit', file_path: BIG_PATH, old_string: oldLines.join('\n'), new_string: newLines.join('\n') }, edit)
    await endSession($)
    const f = h.state().files.get(BIG_PATH)!
    expect([f.linesAdded, f.linesRemoved]).toEqual([5, 3])
    // The 5 new lines are Claude's own (authored); the reads after the hunk shift by +2.
    expect(f.intervals).toEqual([[1, 20], [50, 54], [102, 202]])
    expect(f.authored).toEqual([[50, 54]])
    expect(f.totalLines).toBe(1325)
    expect(f.lastAction).toBe('edit')
  })

  test('Edit remaps coverage through the patch: Read small.ts 1–5, insert 2 after line 3 → 1–7 / 42, 4–5 authored', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: SMALL_PATH, offset: 1, limit: 5 }, readResult(SMALL_PATH, SMALL, 1, 5))
    const small = SMALL.split('\n')
    // Claude Code 2.1.295's Edit result: no file content, a structuredPatch with 3 context lines each side.
    const edit = {
      ref: 1,
      result: {
        filePath: SMALL_PATH, oldString: small[2], newString: `${small[2]}\nexport const v3a = 31;\nexport const v3b = 32;`, originalFile: SMALL, userModified: false, replaceAll: false,
        structuredPatch: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 8, lines: [...small.slice(0, 3).map((l) => ' ' + l), '+export const v3a = 31;', '+export const v3b = 32;', ...small.slice(3, 6).map((l) => ' ' + l)] }],
        contentNotInModelContext: true,
      },
      text: `The file ${SMALL_PATH} has been updated successfully.`,
    }
    await t.call($, { tool: 'Edit', file_path: SMALL_PATH, old_string: small[2], new_string: edit.result.newString }, edit)
    await endSession($)
    const f = h.state().files.get(SMALL_PATH)!
    expect(rangeSummary(f)).toBe('1–7 / 42')
    expect(f.authored).toEqual([[4, 5]])
    // Authoring costs nothing; only the read counts.
    expect(f.estTokens).toBe(f.history[0]!.estTokens)
  })

  test('Read big.md 150–200, Edit near line 100 with net +2 → 152–202, edited lines seen as authored, ≈ read tokens unchanged; a Write then marks it full at no read cost', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 150, limit: 51 }, readResult(BIG_PATH, BIG, 150, 51))
    const big = BIG.split('\n')
    // Line 100 replaced by three lines: minimal patch with 3 context lines each side (oldLines 7 → newLines 9, net +2).
    const added = ['big.md line 100 (edited)', 'inserted A', 'inserted B']
    const patch = [{ oldStart: 97, oldLines: 7, newStart: 97, newLines: 9, lines: [...big.slice(96, 99).map((l) => ' ' + l), '-' + big[99], ...added.map((l) => '+' + l), ...big.slice(100, 103).map((l) => ' ' + l)] }]
    await t.call($, { tool: 'Edit', file_path: BIG_PATH, old_string: big[99], new_string: added.join('\n') }, { ref: 1, result: { filePath: BIG_PATH, oldString: big[99], newString: added.join('\n'), structuredPatch: patch }, text: 'updated' })
    await endSession($)
    const edited = h.state().files.get(BIG_PATH)!
    const readTokens = edited.history[0]!.estTokens!
    expect(edited.intervals).toEqual([[100, 102], [152, 202]])
    expect(edited.authored).toEqual([[100, 102]])
    expect(rangeSummary(edited)).toBe('100–102, 152–202 / 1,325')
    expect(edited).toMatchObject({ linesAdded: 3, linesRemoved: 1, estTokens: readTokens })

    const content = 'x\n'.repeat(1325)
    await t.call($, { tool: 'Write', file_path: BIG_PATH, content }, { ref: 1, result: { type: 'update', filePath: BIG_PATH, content, structuredPatch: [], originalFile: BIG }, text: 'ok' })
    await endSession($)
    const written = h.state().files.get(BIG_PATH)!
    expect(written.coverage).toBe('full')
    expect(rangeSummary(written)).toBe('1–1,325 / 1,325')
    expect(written.estTokens).toBe(readTokens)
  })

  test('reading authored lines turns them into read lines', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Write', file_path: `${CWD}/new.ts`, content: 'a\nb\nc\n' }, { ref: 1, result: { type: 'create', filePath: `${CWD}/new.ts`, content: 'a\nb\nc\n', structuredPatch: [], originalFile: null }, text: 'ok' })
    await t.call($, { tool: 'Read', file_path: `${CWD}/new.ts`, offset: 1, limit: 2 }, readResult(`${CWD}/new.ts`, 'a\nb\nc\n', 1, 2))
    await endSession($)
    const f = h.state().files.get(`${CWD}/new.ts`)!
    expect(f.intervals).toEqual([[1, 3]])
    expect(f.authored).toEqual([[3, 3]])
  })

  test('a Write marks the file full; the payload counts as written, not as cost', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    const content = 'export const x = 1\nexport const y = 2\n'
    await t.call(
      $,
      { tool: 'Write', file_path: `${CWD}/new.ts`, content },
      { ref: 1, result: { type: 'create', filePath: `${CWD}/new.ts`, content, structuredPatch: [], originalFile: null }, text: 'File created' },
    )
    await endSession($)
    const f = h.state().files.get(`${CWD}/new.ts`)!
    expect(f).toMatchObject({ coverage: 'full', intervals: [[1, 2]], estTokens: 0, linesAdded: 2 })
    expect(f.writtenTokens).toBe(Math.ceil(content.length / 4))
  })
})

describe('denied and errored calls', () => {
  test('are logged, add no coverage and light nothing', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, { deny: 'Permission denied by user' })
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, { ref: 1, result: 'File does not exist.', text: 'File does not exist.', isError: true })
    await t.call($, { tool: 'Bash', command: 'cat big.md' }, { deny: 'no' })
    await endSession($)
    const s = h.state()
    const big = s.files.get(BIG_PATH)!
    expect(big.history.map((e) => e.outcome)).toEqual(['denied', 'denied'])
    expect(big).toMatchObject({ intervals: [], reads: 0, estTokens: 0, lastAction: null, coverage: 'none', denied: 2 })
    expect(s.files.get(SMALL_PATH)).toMatchObject({ errors: 1, lastAction: null, lastOutcome: 'error', intervals: [] })
  })
})

describe('permission-settings denial', () => {
  test('an errored result saying "denied by your permission settings" is logged as denied, not errored', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    const secret = `${CWD}/secret.txt`
    await t.call($, { tool: 'Read', file_path: secret }, { ref: 1, result: 'Error: File is in a directory that is denied by your permission settings.', isError: true, text: '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>' })
    await endSession($)
    expect(h.state().files.get(secret)).toMatchObject({ denied: 1, errors: 0, lastAction: null, intervals: [] })
  })
})

describe('agent identity', () => {
  test('every stored event has agentId/agentType; a subagent call stores its id and type', async ($, on) => {
    const h = harness(on)
    const t = tools(on)
    await startSession($)
    await $.classic.SubagentStart({ agent_id: 'a0ccdd61e74e15cd4', agent_type: 'Explore' } as never)
    await t.call($, { tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 300, agentId: 'a0ccdd61e74e15cd4' }, readResult(BIG_PATH, BIG, 1, 300))
    await t.call($, { tool: 'Read', file_path: SMALL_PATH }, readResult(SMALL_PATH, SMALL))
    await endSession($)
    const lines = h.written.get(LOG)!.trim().split('\n').slice(1).map((l) => JSON.parse(l))
    const events = lines.filter((r) => r.t === 'event').map((r) => r.e)
    expect(events.length).toBeGreaterThan(1)
    for (const e of events) {
      expect(Object.keys(e)).toContain('agentId')
      expect(Object.keys(e)).toContain('agentType')
    }
    expect(events.find((e) => e.path === BIG_PATH)).toMatchObject({ agentId: 'a0ccdd61e74e15cd4', agentType: 'Explore' })
    expect(events.find((e) => e.path === SMALL_PATH)).toMatchObject({ agentId: null, agentType: null })
    expect(h.state().files.get(BIG_PATH)!.agents).toEqual(['a0ccdd61e74e15cd4'])
  })

  test("the engine's own forks (empty agent_type) are not registered as agents", async ($, on) => {
    const h = harness(on)
    await startSession($)
    await $.classic.SubagentStart({ agent_id: 'fork1', agent_type: '' } as never)
    await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Plan' } as never)
    await endSession($)
    expect([...h.state().agents]).toEqual([['a1', 'Plan']])
  })
})

describe('observe only', () => {
  test('tool.call results come back unchanged: read, bash, edit, deny, error', async ($, on) => {
    harness(on)
    const t = tools(on)
    await startSession($)
    const answers: [Record<string, unknown>, unknown][] = [
      [{ tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 200 }, readResult(BIG_PATH, BIG, 1, 200)],
      [{ tool: 'Bash', command: 'grep -rn x .' }, bashResult('big.md:1:x')],
      [{ tool: 'Read', file_path: BIG_PATH }, { deny: 'no' }],
      [{ tool: 'Read', file_path: SMALL_PATH }, { ref: 1, result: 'boom', text: 'boom', isError: true }],
      [{ tool: 'Agent', prompt: 'x', subagent_type: 'Explore' }, { ref: 1, result: { agentId: 'a1' }, text: 'launched' }],
    ]
    for (const [input, answer] of answers) {
      const copy = JSON.parse(JSON.stringify(answer))
      expect(await t.call($, input, answer)).toEqual(copy)
    }
  })

  test('the call input reaches Claude Code unchanged', async ($, on) => {
    harness(on)
    const seen: unknown[] = []
    on('tool.call', (_$, e) => {
      seen.push(e)
      return readResult(BIG_PATH, BIG, 1, 10) as never
    })
    await $.tool.call({ tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 10, tool_use_id: 'toolu_x' })
    expect(seen).toEqual([expect.objectContaining({ tool: 'Read', file_path: BIG_PATH, offset: 1, limit: 10, tool_use_id: 'toolu_x' })])
  })

  test('a malformed result neither throws nor changes what Claude gets', async ($, on) => {
    harness(on)
    const t = tools(on)
    await startSession($)
    const weird = { ref: 1, result: { type: 'text', file: null }, text: 42 }
    expect(await t.call($, { tool: 'Read', file_path: BIG_PATH }, weird)).toEqual({ ref: 1, result: { type: 'text', file: null }, text: 42 })
  })

  test('200 tool calls ingest without slowing the hook (no per-call work grows with history)', { timeoutMs: 20_000 }, async ($, on) => {
    harness(on)
    const t = tools(on)
    await startSession($)
    const timeCall = async (i: number) => {
      const t0 = Date.now()
      await t.call($, { tool: 'Read', file_path: `${CWD}/f${i % 20}.ts` }, readResult(`${CWD}/f${i % 20}.ts`, SMALL))
      return Date.now() - t0
    }
    const first: number[] = []
    const last: number[] = []
    for (let i = 0; i < 200; i++) {
      const ms = await timeCall(i)
      if (i < 20) first.push(ms)
      if (i >= 180) last.push(ms)
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(avg(last)).toBeLessThan(Math.max(20, avg(first) * 5))
  })
})
