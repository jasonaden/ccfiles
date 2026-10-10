import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { changedFiles, snapshot } from '../src/git.ts'
import { CWD, SMALL, bashResult, harness, readResult, startSession, tools } from './harness.ts'
import { MIN_TAG_MS } from '../src/view/rows.ts'
import { FC_LIST_ARGV } from '../src/view/detect.ts'
import { clientLines, lineText, rowNode } from './rows-client.ts'
import { screen } from './panel-kit.ts'

const SHA1 = 'a1c9e42' + '0'.repeat(33)
const SHA2 = 'b2d8f51' + '0'.repeat(33)

type Repo = { status: string; numstat: string; aheadBehind: string; branch: string; head: string; diffNames: string }

/** Answers the read-only git commands the mod runs, from a mutable repo state; counts the runs. */
function git(on: On, repo: Repo) {
  const runs: string[] = []
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    runs.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
    if (argv.startsWith('git status')) return ok(repo.status)
    if (argv.startsWith('git diff --numstat')) return ok(repo.numstat)
    if (argv.startsWith('git rev-list')) return repo.aheadBehind ? ok(repo.aheadBehind) : { value: { exitCode: 128, stdout: '', stderr: 'fatal: no upstream', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv === 'git branch --show-current') return ok(`${repo.branch}\n`)
    if (argv === 'git rev-parse HEAD') return ok(`${repo.head}\n`)
    if (argv.startsWith('git diff --name-only')) return ok(repo.diffNames)
    return { deny: `unexpected: ${argv}` }
  })
  return runs
}

describe('git snapshot diff (pure)', () => {
  test('files whose status or line counts changed since the last snapshot', () => {
    const before = snapshot({ root: CWD, status: ' M small.ts\0', numstat: '3\t1\tsmall.ts\n', aheadBehind: '', branch: 'main', head: SHA1 })
    const after = snapshot({ root: CWD, status: ' M small.ts\0?? out.txt\0 M big.md\0', numstat: '3\t1\tsmall.ts\n0\t2\tbig.md\n', aheadBehind: '', branch: 'main', head: SHA1 })
    expect(changedFiles(before, after)).toEqual([
      expect.objectContaining({ path: `${CWD}/out.txt`, letter: '?' }),
      expect.objectContaining({ path: `${CWD}/big.md`, letter: 'M', added: 0, removed: 2 }),
    ])
    expect(changedFiles(after, after)).toEqual([])
  })
})

describe('git and commits', () => {
  test('git letters, ±lines and the branch row; a Bash write shows up from the status scan; a commit lights its files and the footer says committed <sha7>', async ($, on) => {
    const h = harness(on)
    const repo: Repo = { status: ' M small.ts\0', numstat: '3\t1\tsmall.ts\n', aheadBehind: '0\t2\n', branch: 'main', head: SHA1, diffNames: '' }
    const runs = git(on, repo)
    on('config.list', () => ({ value: [] as never }))
    const t = tools(on)
    await startSession($)
    const ui = await $.ui.mount({
      plugin: 'ccfiles', surface: 'terminal', component: 'Pane', requestId: 'ccfiles',
      viewport: { columns: 160, rows: 45, isFullscreen: true },
      props: { title: 'ccfiles', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    await $.prompt.submit({ text: 'hi', wait: false } as never)
    await h.clock.settle()
    await ui.redraw()
    const row = async (p: string) => (await rowNode(ui, `f:${CWD}/${p}`))?.text ?? ''
    // Modified keeps +N −N, no bare M.
    // Git meta sits in its own column before the right column (blank here: nothing read).
    expect(await row('small.ts')).toMatch(/\+3 −1 *$/)
    // The branch row reads `⎇  main ↑2` left and `+3 −1 · 1 mod` right.
    expect(await screen(ui)).toContainEqual(expect.stringMatching(/^⎇  main ↑2 +\+3 −1 · 1 mod$/))

    // A Bash write: the status scan after the call finds the new file.
    repo.status = ' M small.ts\0?? out.txt\0'
    await h.clock.advance(2100)
    await t.call($, { tool: 'Bash', command: 'echo hi > out.txt' }, bashResult(''))
    await h.clock.settle()
    await ui.redraw()
    // Untracked reads `new`, never `??`. No settled word (`wrote`); the gutter says ✎.
    expect(await row('out.txt')).toMatch(/^✎ .*out\.txt +new *$/)

    // A commit: the verb, then HEAD moves; the committed files light up.
    repo.status = '?? out.txt\0'
    repo.numstat = ''
    repo.head = SHA2
    repo.aheadBehind = '0\t3\n'
    repo.diffNames = 'small.ts\n'
    await h.clock.advance(2100)
    await t.call($, { tool: 'Bash', command: 'git commit -am "fix: x"' }, bashResult('[main b2d8f51] fix: x\n 1 file changed, 3 insertions(+), 1 deletion(-)'))
    await h.clock.settle()
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    // The committed file shows ◆ and its name stays in the commit colour (the ◆'s), no `committed`
    // word in the row; the footer chip says `✓ committed b2d8f51`.
    const committed = (await clientLines(ui)).find((l) => l.id === `f:${CWD}/small.ts`)!
    expect(lineText(committed)).toMatch(/^◆ /)
    expect(lineText(committed)).not.toMatch(/committed/)
    expect(committed.segs.find((x) => x.t === 'small.ts')!.c).toBe(committed.segs[0]!.c)
    expect(await ui.find({ type: 'Text', text: /committed b2d8f51/ })).toBeDefined()
    expect(await screen(ui)).toContainEqual(expect.stringMatching(/^⎇  main ↑3\b/))
    // Read-only git only, plus the one local `fc-list` font probe for `glyphs: auto`.
    expect(runs.filter((r) => r !== FC_LIST_ARGV.join(' ')).every((r) => r.startsWith('git '))).toBe(true)
    expect(runs.some((r) => /\b(add|commit|push|reset|checkout|stash)\b/.test(r))).toBe(false)
  })

  test('refreshes are throttled to one per 2 s (a trailing run catches up)', async ($, on) => {
    const h = harness(on)
    const runs = git(on, { status: '', numstat: '', aheadBehind: '', branch: 'main', head: SHA1, diffNames: '' })
    await startSession($)
    for (let i = 0; i < 5; i++) await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.settle()
    const statusRuns = () => runs.filter((r) => r.startsWith('git status')).length
    expect(statusRuns()).toBe(1)
    await h.clock.advance(2100)
    expect(statusRuns()).toBe(2)
    await h.clock.advance(5000)
    expect(statusRuns()).toBe(2)
  })

  test('SessionStart asks to watch .git/index and HEAD; a FileChanged on them refreshes git', async ($, on) => {
    const h = harness(on)
    const runs = git(on, { status: '', numstat: '', aheadBehind: '', branch: 'main', head: SHA1, diffNames: '' })
    const r = await $.classic.SessionStart({ source: 'startup', transcript_path: '/home/u/.claude/projects/-tmp-ccfiles/s1.jsonl', cwd: CWD } as never)
    expect(r.watchPaths).toEqual([`${CWD}/.git/index`, `${CWD}/.git/HEAD`])
    await $.classic.FileChanged({ file_path: `${CWD}/.git/index`, event: 'change' } as never)
    await h.clock.settle()
    expect(runs.filter((x) => x.startsWith('git status'))).toHaveLength(1)
    await $.classic.FileChanged({ file_path: `${CWD}/notes.txt`, event: 'change' } as never)
    await h.clock.advance(2100)
    expect(runs.filter((x) => x.startsWith('git status'))).toHaveLength(1)
  })

  test('an Edit then a Bash call within 2 s: the edited file is not also a Bash write; git add of a new file is not a write', async ($, on) => {
    const h = harness(on)
    const repo: Repo = { status: '?? new.ts\0', numstat: '', aheadBehind: '', branch: 'main', head: SHA1, diffNames: '' }
    git(on, repo)
    const t = tools(on)
    await startSession($)
    await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.settle()
    const small = `${CWD}/small.ts`
    repo.status = ' M small.ts\0?? new.ts\0'
    repo.numstat = '1\t0\tsmall.ts\n'
    await t.call($, { tool: 'Edit', file_path: small, old_string: 'a', new_string: 'b' }, { ref: 1, result: { filePath: small, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }] }, text: 'ok' })
    repo.status = ' M small.ts\0A  new.ts\0'
    repo.numstat = '1\t0\tsmall.ts\n40\t0\tnew.ts\n'
    await t.call($, { tool: 'Bash', command: 'git add new.ts && npm test' }, bashResult('ok'))
    await h.clock.advance(2100)
    await $.classic.SessionEnd({ reason: 'other' } as never)
    const scan = h.state().events.filter((e) => e.source === 'gitScan')
    expect(scan).toEqual([])
    expect(h.state().files.get(small)!.edits).toBe(1)
  })

  test('a failed git commit does not arm commit lighting for a later HEAD move', async ($, on) => {
    const h = harness(on)
    const repo: Repo = { status: '', numstat: '', aheadBehind: '', branch: 'main', head: SHA1, diffNames: 'small.ts\n' }
    git(on, repo)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.settle()
    await h.clock.advance(2100)
    await t.call($, { tool: 'Bash', command: 'git commit -m x' }, { ...bashResult('nothing to commit'), isError: true })
    await h.clock.advance(2100)
    repo.head = SHA2
    await t.call($, { tool: 'Bash', command: 'git pull' }, bashResult('Updating'))
    await h.clock.advance(2100)
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(h.state().events.filter((e) => e.kind === 'commit')).toEqual([])
  })

  test('HEAD moving without a commit verb (checkout, pull) lights nothing', async ($, on) => {
    const h = harness(on)
    const repo: Repo = { status: '', numstat: '', aheadBehind: '', branch: 'main', head: SHA1, diffNames: 'small.ts\n' }
    git(on, repo)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: `${CWD}/small.ts` }, readResult(`${CWD}/small.ts`, SMALL))
    await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.settle()
    repo.head = SHA2
    await h.clock.advance(2100)
    await t.call($, { tool: 'Bash', command: 'git pull' }, bashResult('Updating a1c9e42..b2d8f51'))
    await h.clock.settle()
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(h.state().events.filter((e) => e.kind === 'commit')).toEqual([])
  })
})
