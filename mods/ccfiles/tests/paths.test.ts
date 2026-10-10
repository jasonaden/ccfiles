// Tool output and prompt text never become rows by themselves.
import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'
import { bashActions } from '../src/bash.ts'
import { rootSpelling } from '../src/paths.ts'
import { makeEvent } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { treeRows } from '../src/view/rows.ts'
import { bashResult, CWD, FILES, harness, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clientLines } from './rows-client.ts'

const P = '/p'
const hits = (command: string, stdout: string) =>
  bashActions(command, { cwd: P, stdout, text: stdout, totals: () => null })
    .filter((a) => a.kind === 'hit')
    .map((a) => a.path)

// Four bogus rows, exactly as they once reached the panel.
const CLI_LINE = 'cli.ts:164:  `output v${result.settings.build_versi…'
const BOGUS = [CLI_LINE, '** Which stores to search', '+ /', 'adr']

describe('which stage writes stdout decides how its lines read (pure)', () => {
  test('`rg -l X | xargs rg -n Y`: the -n search writes stdout, so its `path:line:` lines are matches; nothing else', () => {
    expect(hits('rg -l X | xargs rg -n Y', 'docs/a.md:3:Y here\n+    /x\n** Which stores to search')).toEqual([`${P}/docs/a.md`])
  })
  test('`grep -rl X docs | xargs cat`: cat writes stdout (file text), so no line is a path', () => {
    expect(hits('grep -rl X docs | xargs cat', '# ADR 15\n** Which stores to search\n+    /x\ndocs/adr')).toEqual([])
  })
  test('`rg -l a && rg -n b`: two commands write stdout, so bare lines are not paths; `path:line:` lines still are', () => {
    expect(hits('rg -l a && rg -n b', 'src/a.ts\nsrc/b.ts:4:b')).toEqual([`${P}/src/b.ts`])
  })
  test('a lone `rg -l` (or through head/sort) still lists paths', () => {
    expect(hits('rg -l X', 'src/a.ts\nsrc/b.ts')).toEqual([`${P}/src/a.ts`, `${P}/src/b.ts`])
    expect(hits('rg -l X | sort | head -5', 'src/a.ts')).toEqual([`${P}/src/a.ts`])
    expect(hits('cd sub && rg --files', 'a.ts')).toEqual([`${P}/sub/a.ts`])
  })
  test('`rg -n`: `path:line:text` names the path only', () => {
    expect(hits('rg -n foo', 'packages/cli/src/paths.ts:12:foo')).toEqual([`${P}/packages/cli/src/paths.ts`])
    expect(hits('rg -n schema', CLI_LINE)).toEqual([`${P}/cli.ts`])
  })
  test('`grep -rn`: a hyphenated file name is cut at `:line:`, not at the first `-digits-`', () => {
    expect(hits('grep -rn x docs', 'docs/adr-003-doc.md:5:x')).toEqual([`${P}/docs/adr-003-doc.md`])
  })
  test('a git diff before a search: its `+ /` lines are not paths', () => {
    expect(hits('git diff && rg -l X', '+ /\n+    /x\nsrc/a.ts')).toEqual([])
  })
})

/** The project on disk for the hook tests: real files and a folder `docs/adr` (no `adr` at the root). */
const DISK: Record<string, string> = {
  ...FILES,
  [`${CWD}/cli.ts`]: 'x\n',
  [`${CWD}/packages/cli/src/paths.ts`]: 'x\n',
  [`${CWD}/docs/adr/015-data-retention-policy-docs.md`]: '# 015\n',
}

/** Answers git's read-only commands: `gone.ts` is deleted in the work tree. */
function git(on: On) {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
    if (argv.startsWith('git status')) return ok(' D gone.ts\0')
    if (argv.startsWith('git diff --numstat')) return ok('0\t9\tgone.ts\n')
    if (argv === 'git branch --show-current') return ok('main\n')
    if (argv === 'git rev-parse HEAD') return ok('a'.repeat(40) + '\n')
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

async function touchedPaths($: Engine, h: ReturnType<typeof harness>): Promise<string[]> {
  await h.clock.settle()
  return [...h.state().files.keys()].filter((p) => p.startsWith(CWD)).map((p) => p.slice(CWD.length + 1)).sort()
}

describe('only existing files (or git-deleted ones) make rows', () => {
  test('the bogus fixtures as one `rg -l` output: no rows; as `rg -n` output: a match on cli.ts only', async ($, on) => {
    const h = harness(on, DISK)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'rg -l stores' }, bashResult(BOGUS.join('\n')))
    await t.call($, { tool: 'Bash', command: 'rg -n schema' }, bashResult(BOGUS.join('\n')))
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(await touchedPaths($, h)).toEqual(['cli.ts'])
    expect(h.state().files.get(`${CWD}/cli.ts`)!.coverage).toBe('hit')
  })

  test('the same lines as Grep tool output (content mode): a match on cli.ts only', async ($, on) => {
    const h = harness(on, DISK)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Grep', pattern: 'schema', output_mode: 'content', '-n': true }, { ref: 1, result: { mode: 'content', numFiles: 1, filenames: [], content: BOGUS.join('\n'), numLines: 4 }, text: BOGUS.join('\n') })
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(await touchedPaths($, h)).toEqual(['cli.ts'])
  })

  test('a real `rg -n` result marks the file only; the three pipelines add no bogus rows', async ($, on) => {
    const h = harness(on, DISK)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'rg -n foo' }, bashResult('packages/cli/src/paths.ts:12:foo'))
    await t.call($, { tool: 'Bash', command: 'rg -l X | xargs rg -n Y' }, bashResult('cli.ts:3:Y\n+    /x\n** Which stores to search'))
    await t.call($, { tool: 'Bash', command: 'grep -rl X docs | xargs cat' }, bashResult('# 015\n** Which stores to search\n+ /\nadr'))
    await t.call($, { tool: 'Bash', command: 'rg -l a && rg -n b' }, bashResult('docs\nadr\ncli.ts:4:b'))
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(await touchedPaths($, h)).toEqual(['cli.ts', 'packages/cli/src/paths.ts'])
  })

  test('`ls docs/adr` never records the folder as a file; a bare `adr` at the root names nothing', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Bash', command: 'ls docs/adr' }, bashResult('015-data-retention-policy-docs.md'))
    await t.call($, { tool: 'Bash', command: 'ls adr' }, bashResult(''))
    await t.call($, { tool: 'Bash', command: 'find docs' }, bashResult('docs\ndocs/adr\ndocs/adr/015-data-retention-policy-docs.md'))
    const ui = await $.ui.mount(pane(60, 20))
    // Folder names have no trailing `/`, so the check reads row kinds: `docs/adr` may show as a
    // folder row, never as a file row, and nothing at all is named `adr` at the root.
    const ids = (await clientLines(ui)).map((l) => l.id)
    expect(ids.filter((id) => id.startsWith('f:') && /\/adr$/.test(id))).toEqual([])
    expect(ids).not.toContain(`d:${CWD}/adr`)
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(await touchedPaths($, h)).toEqual(['docs/adr/015-data-retention-policy-docs.md'])
  })

  test('a path deleted in git still gets its match, and a `del` row', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    git(on)
    const t = tools(on)
    await startSession($)
    await $.prompt.submit({ text: 'hi', wait: false } as never)
    await h.clock.settle()
    await t.call($, { tool: 'Bash', command: 'rg -l old' }, bashResult('gone.ts\nnot-there.ts'))
    await $.classic.SessionEnd({ reason: 'other' } as never)
    expect(await touchedPaths($, h)).toEqual(['gone.ts'])
    const ui = await $.ui.mount(pane(60, 20))
    // The type icon sits between the gutter and the name; `del` is in the git column.
    expect((await screen(ui)).find((l) => l.includes('gone.ts'))).toMatch(/^◇ +\S +gone\.ts .*del *$/)
  })
})

describe('Tree never draws a folder as a file', () => {
  test('a log that recorded `docs/adr` as a listing shows one adr/ folder row and no adr file row', () => {
    const state = replay([{ t: 'event', e: makeEvent({ kind: 'listing', path: `${P}/docs/adr`, source: 'tool', tool: 'Bash:ls', ts: 1 }) }])
    const rows = treeRows({ state, root: P, home: null, projectFiles: [`${P}/docs/adr/015.md`], git: null, pending: new Map(), now: 10 }, { expanded: new Set([`${P}/docs`]), query: '', sort: 'recent' })
    expect(rows.filter((r) => r.label.replace(/\/$/, '') === 'adr').map((r) => r.kind)).toEqual(['dir'])
  })
})

describe('macOS alias spelling', () => {
  test('a /tmp path under a /private/tmp root takes the root spelling, and the reverse', () => {
    expect(rootSpelling('/tmp/fx/sub/a.ts', '/private/tmp/fx')).toBe('/private/tmp/fx/sub/a.ts')
    expect(rootSpelling('/private/tmp/fx/a.ts', '/tmp/fx')).toBe('/tmp/fx/a.ts')
    expect(rootSpelling('/tmp/other/a.ts', '/private/tmp/fx')).toBe('/tmp/other/a.ts')
    expect(rootSpelling('/tmp/fx/a.ts', null)).toBe('/tmp/fx/a.ts')
  })
})
