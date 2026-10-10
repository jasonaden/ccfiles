// Through the mounted panel: git per outside section and the branch row's repo, the Touched tab's section groups,
// and additional directories from the settings files.
import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { CWD, FILES, harness, readResult, startSession, tools } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clickRow, clientLines, lineText } from './rows-client.ts'
import { LIT_MS } from '../src/view/rows.ts'

const O = '/tmp/ccfiles-other'
const X = `${O}/src/x.ts`
const SHARED = '/work/shared'
const A = `${SHARED}/pkg/a.ts`
const files: Record<string, string> = { ...FILES, [X]: 'export const x = 1\n', [`${O}/src/y.ts`]: 'export const y = 2\n', [`${O}/README.md`]: '# other\n', [A]: 'export const a = 1\n' }

type Run = { argv: string; cwd: string | undefined }

/**
 * Answers the read-only git commands: the session repo at CWD (branch main, small.ts modified), the other repo at O
 * (branch feature, src/x.ts modified), `/work/shared/pkg` its own repo, and nothing else a repo.
 */
function git(on: On, opts: { failFirstLookup?: boolean } = {}): Run[] {
  const runs: Run[] = []
  let failLookup = opts.failFirstLookup ?? false
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const cwd = e.init?.cwd
    runs.push({ argv, cwd })
    const out = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[1] === '-C') {
      if (failLookup) {
        failLookup = false
        throw new Error('still running at the timeout')
      }
      const dir = e.argv[2]!
      for (const top of [O, `${SHARED}/pkg`]) if (dir === top || dir.startsWith(top + '/')) return out(0, `${top}\n${dir === top ? '' : dir.slice(top.length + 1) + '/'}\n`)
      return out(128)
    }
    const other = cwd === O
    if (argv === 'git rev-parse --show-toplevel') return out(0, `${CWD}\n`)
    if (argv.startsWith('git status')) return out(0, other ? ' M src/x.ts\0' : ' M small.ts\0')
    if (argv.startsWith('git diff --numstat')) return out(0, other ? '4\t2\tsrc/x.ts\n' : '3\t1\tsmall.ts\n')
    if (argv === 'git branch --show-current') return out(0, other ? 'feature\n' : 'main\n')
    if (argv === 'git rev-parse HEAD') return out(0, 'a'.repeat(40) + '\n')
    return out(128)
  })
  return runs
}

const nameColor = async (ui: Parameters<typeof clientLines>[0], path: string, name: string) =>
  (await clientLines(ui)).find((l) => l.id === `f:${path}`)?.segs.find((s) => s.t === name)?.c

describe('git per outside section', () => {
  test('an open section\'s repo gets its own status in that repo, throttled to 2 s; its rows show its git; the branch row follows the focus', { options: { glyphs: 'plain' } }, async ($, on) => {
    const h = harness(on, files)
    host(on)
    const runs = git(on)
    const t = tools(on)
    await startSession($)
    const ui = await $.ui.mount(pane(70, 24))
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await h.clock.settle()
        await ui.redraw()
      }
    }
    await $.prompt.submit({ text: 'hi', wait: false } as never)
    await t.call($, { tool: 'Read', file_path: X }, readResult(X, files[X]!))
    await settle()
    const otherStatus = () => runs.filter((r) => r.cwd === O && r.argv.startsWith('git status')).length
    // The section is open by default: one status run, in the other repo.
    expect(otherStatus()).toBe(1)
    await h.clock.advance(LIT_MS + 100)
    await settle()
    // Its file shows that repo's change, named in the same git.M colour as the session's modified small.ts.
    const x = (await clientLines(ui)).find((l) => l.id === `f:${X}`)!
    expect(lineText(x)).toMatch(/\+4 −2/)
    expect(await nameColor(ui, X, 'x.ts')).toBe(await nameColor(ui, `${CWD}/small.ts`, 'small.ts'))
    // Unfocused, the branch row is the session repo's.
    expect(await screen(ui)).toContainEqual(expect.stringMatching(/^⎇  main\b/))

    // Throttle: three triggers in a row run once now and once at the end of the 2 s window.
    for (let i = 0; i < 3; i++) await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.settle()
    expect(otherStatus()).toBe(2)
    await h.clock.advance(2100)
    expect(otherStatus()).toBe(3)
    await h.clock.advance(5000)
    expect(otherStatus()).toBe(3)

    // Focus the section (a double-click on its header): the branch row is the other repo's; rows keep its git.
    await clickRow(ui, `r:${O}`)
    await clickRow(ui, `r:${O}`)
    await settle()
    const focused = await screen(ui)
    expect(focused).toContainEqual(expect.stringMatching(/^⎇  feature\b/))
    expect(focused.some((l) => /^⎇  main\b/.test(l))).toBe(false)
    expect(lineText((await clientLines(ui)).find((l) => l.id === `f:${X}`)!)).toMatch(/\+4 −2/)

    // ↑ to /tmp: above every repo, no branch row.
    await ui.press({ key: 'btn:up' })
    await settle()
    expect((await screen(ui)).some((l) => l.startsWith('⎇'))).toBe(false)

    // ⌂ back: the session's branch row again.
    await ui.press({ key: 'btn:home' })
    await settle()
    expect(await screen(ui)).toContainEqual(expect.stringMatching(/^⎇  main\b/))

    // A double-click only focuses (its first press's toggle is undone): close the section by hand. Closed and
    // unfocused, the other repo is never asked again.
    await clickRow(ui, `r:${O}`)
    await settle()
    expect((await clientLines(ui)).some((l) => l.id === `f:${X}`)).toBe(false)
    await h.clock.advance(2100)
    const before = otherStatus()
    await $.prompt.submit({ text: 'x', wait: false } as never)
    await h.clock.advance(2100)
    await settle()
    expect(otherStatus()).toBe(before)

    // Every outside command was read-only git, run in the other repo or naming its directory with -C.
    const outside = runs.filter((r) => r.cwd === O || r.argv.startsWith('git -C '))
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.every((r) => r.argv.startsWith('git ') && !/\b(add|commit|push|reset|checkout|stash)\b/.test(r.argv))).toBe(true)
  })

  test('nothing runs for an outside repo while the panel is closed', { options: { glyphs: 'plain' } }, async ($, on) => {
    const h = harness(on, files)
    host(on)
    const runs = git(on)
    const t = tools(on)
    await startSession($)
    await t.call($, { tool: 'Read', file_path: X }, readResult(X, files[X]!))
    for (let i = 0; i < 3; i++) {
      await $.prompt.submit({ text: 'x', wait: false } as never)
      await h.clock.advance(2100)
    }
    expect(runs.some((r) => r.cwd === O)).toBe(false)
  })
})

describe('Touched tab grouped by section, in the panel', () => {
  test('project files first, then the outside section\'s header and its files', { options: { glyphs: 'plain' } }, async ($, on) => {
    const h = harness(on, files)
    host(on)
    git(on)
    const t = tools(on)
    await startSession($)
    const ui = await $.ui.mount(pane(70, 24))
    const small = `${CWD}/small.ts`
    await t.call($, { tool: 'Read', file_path: X }, readResult(X, files[X]!))
    await t.call($, { tool: 'Read', file_path: small }, readResult(small, files[small]!))
    await ui.press({ key: 'tab:touched' })
    for (let i = 0; i < 4; i++) {
      await h.clock.settle()
      await ui.redraw()
    }
    const ids = (await clientLines(ui)).map((l) => l.id).filter(Boolean)
    expect(ids).toEqual([`f:${small}`, `t:${O}`, `f:${X}`])
    const lines = (await clientLines(ui)).map(lineText)
    expect(lines.find((l) => l.includes(O))).toBeDefined()
    expect(lines.find((l) => /src\/x\.ts/.test(l))).toBeDefined()
  })
})

describe('permissions.additionalDirectories from the settings files', () => {
  const run = async ($: Engine, on: On, settings: Record<string, string>, opts: { failFirstLookup?: boolean; file?: string } = {}) => {
    const h = harness(on, { ...files, ...settings })
    host(on)
    const runs = git(on, opts)
    const t = tools(on)
    await startSession($)
    const ui = await $.ui.mount(pane(70, 24))
    const file = opts.file ?? A
    await t.call($, { tool: 'Read', file_path: file }, readResult(file, files[file]!))
    for (let i = 0; i < 4; i++) {
      await h.clock.settle()
      await ui.redraw()
    }
    lookups = runs.filter((r) => r.argv.startsWith('git -C')).length
    return (await clientLines(ui)).map((l) => l.id).filter((id) => id.startsWith('r:'))
  }
  let lookups = 0

  test('without settings, git roots the file at its own repo', { options: { glyphs: 'plain' } }, async ($, on) => {
    expect(await run($, on, {})).toEqual([`r:${SHARED}/pkg`])
  })

  test('a git lookup that never finished (timed out) is asked again, not taken as "no repo"', { options: { glyphs: 'plain' } }, async ($, on) => {
    expect(await run($, on, {}, { failFirstLookup: true, file: X })).toEqual([`r:${O}`])
    expect(lookups).toBeGreaterThan(1)
  })

  test('a directory in the project settings roots it instead; a broken local settings file changes nothing', { options: { glyphs: 'plain' } }, async ($, on) => {
    const ids = await run($, on, {
      [`${CWD}/.claude/settings.json`]: JSON.stringify({ permissions: { additionalDirectories: [SHARED] } }),
      [`${CWD}/.claude/settings.local.json`]: '{ broken',
    })
    expect(ids).toEqual([`r:${SHARED}`])
  })

  test('the user settings in CLAUDE_CONFIG_DIR count too', { options: { glyphs: 'plain' } }, async ($, on) => {
    mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/u' })
    expect(await run($, on, { '/cfg/settings.json': JSON.stringify({ permissions: { additionalDirectories: [SHARED] } }) })).toEqual([`r:${SHARED}`])
  })
})
