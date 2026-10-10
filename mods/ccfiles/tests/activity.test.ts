// The activity indicator. The row being read, edited or committed shows `◌` and its name shimmers (there is no
// `reading`/`editing`/`committing` tag word); nothing else animates;
// every row is one line in every frame; lights expiring never move the list.
import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { RowLine } from '../hooks/rows.ts'
import { defaultPalette, readableOn } from '../src/palette.ts'
import { shimmerBands } from '../src/view/draw.ts'
import { LIT_MS, MIN_TAG_MS } from '../src/view/rows.ts'
import { cellWidth } from '../src/view/text.ts'
import { BIG, CWD, FILES, SMALL, SUB_A, bashResult, harness, readResult, startSession } from './harness.ts'
import { host, pane, screen } from './panel-kit.ts'
import { clientLines, lineText } from './rows-client.ts'

type T = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const clientRows = async (ui: { drawn: (s?: never) => Promise<unknown> }) => ((await ui.drawn({ in: 'rows' } as never)) as T).children as T[]
const cells = (row: T) => (row.children as T[]).map((c) => ({ text: (c.children as string[]).join(''), bg: c.props?.backgroundColor as string | undefined }))

const MANY = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${CWD}/many/f${String(i).padStart(2, '0')}.ts`, `line ${i}\n`]))
const DISK = { ...FILES, ...MANY }

/** Tool calls that stay in flight until released, so several overlap (parallel tool use). */
function inFlight(on: On) {
  const answers = new Map<string, (v: unknown) => void>()
  const early = new Map<string, unknown>()
  on('tool.call', (_$, e) => {
    const id = e.tool_use_id ?? ''
    if (early.has(id)) return early.get(id) as never
    return new Promise((r) => answers.set(id, r)) as never
  })
  let n = 0
  return {
    start($: Engine, input: Record<string, unknown>) {
      const id = `toolu_${++n}`
      return { id, done: $.tool.call({ ...input, tool_use_id: id } as never) }
    },
    release(id: string, answer: unknown) {
      const r = answers.get(id)
      if (r) r(answer)
      else early.set(id, answer)
    },
    /** Settles every call still in flight (denied), so none outlives its test. */
    async releaseAll() {
      for (const [id, r] of answers) {
        answers.delete(id)
        r({ deny: 'cancelled by the test' })
      }
      await Promise.resolve()
    },
  }
}

/** git with `small.ts` staged, so a `git commit` in flight shows `committing` on it. */
function git(on: On) {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv === 'git rev-parse --show-toplevel') return ok(`${CWD}\n`)
    if (argv.startsWith('git status')) return ok('M  small.ts\0')
    if (argv.startsWith('git diff --numstat')) return ok('2\t1\tsmall.ts\n')
    if (argv === 'git branch --show-current') return ok('main\n')
    if (argv === 'git rev-parse HEAD') return ok('a'.repeat(40) + '\n')
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const rowLine = async (ui: Parameters<typeof clientLines>[0], path: string): Promise<RowLine> => (await clientLines(ui)).find((l) => l.id === `f:${path}`) ?? { id: '', segs: [] }
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** The code points [from, to) of the file's name in its line: where the band runs. */
const nameSpan = (l: RowLine, path: string): [number, number] => {
  const text = lineText(l)
  const from = [...text.slice(0, text.indexOf(` ${base(path)}`) + 1)].length
  return [from, from + [...base(path)].length]
}
/** In flight = `◌` in the gutter and the band on the name, and no tag word anywhere in the row. */
async function shimmering(ui: Parameters<typeof clientLines>[0], path: string, state: string): Promise<void> {
  const l = await rowLine(ui, path)
  expect(lineText(l).startsWith('◌')).toBe(true)
  expect(l.sh).toBe(state)
  expect(l.at).toEqual(nameSpan(l, path))
  expect(lineText(l)).not.toMatch(/reading|editing|committing/)
}
/** Settled: no band, no `◌` in the gutter, and no settled word. */
async function settled(ui: Parameters<typeof clientLines>[0], path: string): Promise<void> {
  const l = await rowLine(ui, path)
  expect(l.sh).toBeUndefined()
  expect(lineText(l)).not.toMatch(/^◌|reading|editing|committing| read\b|edited|wrote|committed/)
}
/** The colour the name is drawn in, as the row draws it. */
const nameColor = (l: RowLine, path: string) => l.segs.find((s) => s.t === base(path))?.c

describe('parallel reads', () => {
  // No tag word: each name shimmers on its own.
  test('five Reads in flight before any settles: every row shows ◌ and its name shimmers; each settles on its own', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 30))
    const paths = [0, 1, 2, 3, 4].map((i) => `${CWD}/many/f0${i}.ts`)
    const started = paths.map((p) => ({ p, ...calls.start($, { tool: 'Read', file_path: p }) }))
    await h.clock.settle()
    await ui.redraw()
    for (const p of paths) await shimmering(ui, p, 'read')
    expect((await clientLines(ui)).filter((l) => l.sh)).toHaveLength(5)
    calls.release(started[0]!.id, readResult(paths[0]!, MANY[paths[0]!]!))
    await started[0]!.done
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    await settled(ui, paths[0]!)
    for (const p of paths.slice(1)) await shimmering(ui, p, 'read')
    for (const s of started.slice(1)) calls.release(s.id, readResult(s.p, MANY[s.p]!))
    await Promise.all(started.map((s) => s.done))
    await h.clock.advance(MIN_TAG_MS)
    await ui.redraw()
    expect((await clientLines(ui)).some((l) => l.sh)).toBe(false)
  })
})

describe('one line during activity, no bar', () => {
  for (const variant of ['dark', 'light'] as const) {
    for (const depth of ['truecolor', '256'] as const) {
      // Each name shimmers in its state and no row has a tag word.
      test(`${variant} ${depth}: a read, an edit and a commit in flight shimmer their names; every frame, every row is one line at 39, 60 and 100`, async ($, on) => {
        const h = harness(on, DISK)
        host(on, variant)
        git(on)
        mock.env(on, depth === 'truecolor' ? { COLORTERM: 'truecolor', TERM: 'xterm-256color' } : { TERM: 'xterm-256color' })
        const calls = inFlight(on)
        await startSession($)
        await $.prompt.submit({ text: 'hi', wait: false } as never)
        await h.clock.settle()
        const read = calls.start($, { tool: 'Read', file_path: `${CWD}/big.md` })
        const edit = calls.start($, { tool: 'Edit', file_path: `${CWD}/sub/a.ts`, old_string: 'a', new_string: 'b' })
        const commit = calls.start($, { tool: 'Bash', command: 'git commit -m "x"' })
        const reads = [0, 1, 2].map((i) => calls.start($, { tool: 'Read', file_path: `${CWD}/many/f0${i}.ts` }))
        await h.clock.settle()
        for (const width of [39, 60, 100]) {
          const ui = await $.ui.mount(pane(width, 24))
          await shimmering(ui, `${CWD}/big.md`, 'read')
          await shimmering(ui, `${CWD}/sub/a.ts`, 'edit')
          await shimmering(ui, `${CWD}/small.ts`, 'commit')
          for (let frame = 0; frame < 12; frame++) {
            const lines = await screen(ui)
            expect(lines).toHaveLength(24)
            for (const l of lines) {
              expect(l).not.toContain('\n')
              expect(cellWidth(l)).toBeLessThanOrEqual(width)
            }
            for (const r of await clientRows(ui)) {
              expect(r.props?.height).toBe(1)
              expect(cells(r).reduce((n, c) => n + cellWidth(c.text), 0)).toBe(width)
            }
            await ui.advance(90)
          }
          await ui.unmount()
        }
        calls.release(read.id, readResult(`${CWD}/big.md`, BIG, 1, 200))
        calls.release(edit.id, { ref: 1, result: { filePath: `${CWD}/sub/a.ts` }, text: 'updated' })
        calls.release(commit.id, bashResult('[main abc1234] x'))
        for (const r of reads) calls.release(r.id, readResult(`${CWD}/many/f00.ts`, 'x\n'))
        await Promise.all([read.done, edit.done, commit.done, ...reads.map((r) => r.done)])
        await h.clock.advance(MIN_TAG_MS)
        const ui = await $.ui.mount(pane(60, 24))
        expect((await clientLines(ui)).some((l) => l.sh)).toBe(false)
        // Settled rows keep their state glyph and draw no settled word (the fill shows only with `coverage: fill`).
        for (const p of [`${CWD}/big.md`, `${CWD}/sub/a.ts`, `${CWD}/small.ts`]) await settled(ui, p)
      })
    }
  }

  // The band crosses the name only.
  test('the band crosses the name only (every name cell over a sweep), never the gutter, icon, marks or right side', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const width = 60
    const ui = await $.ui.mount(pane(width))
    calls.start($, { tool: 'Read', file_path: `${CWD}/sub/a.ts` })
    await h.clock.settle()
    await ui.redraw()
    const lines = await clientLines(ui)
    const line = lines.find((l) => l.id === `f:${CWD}/sub/a.ts`)!
    expect(line.sh).toBe('read')
    const text = lineText(line)
    const tagFrom = cellWidth(text.slice(0, text.indexOf(' a.ts') + 1))
    expect(line.at).toEqual([tagFrom, tagFrom + 'a.ts'.length])
    const y = lines.indexOf(line)
    const band = new Set(shimmerBands(defaultPalette('dark')).read.map((b) => b.bg))
    const lit = new Set<number>()
    for (let frame = 0; frame < 40; frame++) {
      let col = 0
      for (const c of cells((await clientRows(ui))[y]!)) {
        if (c.bg && band.has(c.bg)) for (let i = 0; i < cellWidth(c.text); i++) lit.add(col + i)
        col += cellWidth(c.text)
      }
      await ui.advance(90)
    }
    expect([...lit].sort((a, b) => a - b)).toEqual(Array.from({ length: 'a.ts'.length }, (_, i) => tagFrom + i))
    await calls.releaseAll()
    void SUB_A
  })

  test('two rows in flight shimmer out of step (each row its own phase)', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60))
    calls.start($, { tool: 'Read', file_path: `${CWD}/many/f00.ts` })
    calls.start($, { tool: 'Read', file_path: `${CWD}/many/f01.ts` })
    await h.clock.settle()
    await ui.redraw()
    const shimmering = (await clientLines(ui)).filter((l) => l.sh)
    expect(shimmering).toHaveLength(2)
    expect(shimmering[0]!.ph).not.toBe(shimmering[1]!.ph)
    await calls.releaseAll()
  })

  test('grep hits and listings never shimmer or light: no tag, no band, no timer', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 40))
    const names = Object.keys(MANY).map((p) => p.slice(CWD.length + 1))
    const rg = calls.start($, { tool: 'Bash', command: 'rg -l line' })
    calls.release(rg.id, bashResult(names.join('\n')))
    await rg.done
    const ls = calls.start($, { tool: 'Bash', command: 'ls many' })
    calls.release(ls.id, bashResult(''))
    await ls.done
    await h.clock.settle()
    await ui.redraw()
    const lines = await clientLines(ui)
    expect(lines.filter((l) => l.id.startsWith(`f:${CWD}/many/`)).length).toBeGreaterThan(20)
    expect(lines.some((l) => l.sh)).toBe(false)
    expect(lines.map(lineText).join('\n')).not.toMatch(/ hit$| listed$/)
    const before = lines.map(lineText)
    await ui.advance(900)
    expect((await clientLines(ui)).map(lineText)).toEqual(before)
  })
})

// The ~600 ms minimum applies to the name shimmer; after it the name keeps its static state colour for ~2.7 s, then
// its git colour.
describe('minimum shimmer time', () => {
  const f = (i: number) => `${CWD}/many/f0${i}.ts`
  const read = (i: number) => readResult(f(i), MANY[f(i)]!)

  test('a Read that settles in 20 ms shimmers until ~600 ms, then its name stays in the read colour for ~2.7 s', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 30))
    const c = calls.start($, { tool: 'Read', file_path: f(0) })
    await h.clock.advance(20)
    calls.release(c.id, read(0))
    await c.done
    await ui.redraw()
    await shimmering(ui, f(0), 'read')
    await h.clock.advance(500)
    await ui.redraw()
    await shimmering(ui, f(0), 'read')
    await h.clock.advance(100)
    await ui.redraw()
    await settled(ui, f(0))
    const lit = await rowLine(ui, f(0))
    const dark = defaultPalette('dark')
    const at = (l: RowLine) => l.segs.find((s) => s.t === base(f(0)))!
    expect(nameColor(lit, f(0))).toBe(readableOn(dark.colors.read, at(lit).bg ?? dark.background, dark))
    // ~2.7 s after it settled, the name is back in its git colour (touched and clean: `text`).
    await h.clock.advance(LIT_MS)
    await ui.redraw()
    const back = await rowLine(ui, f(0))
    expect(nameColor(back, f(0))).toBe(readableOn(dark.colors.text, at(back).bg ?? dark.background, dark))
  })

  test('parallel fast Reads each shimmer for ~600 ms from their own start', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 30))
    const started: { id: string; done: Promise<unknown> }[] = []
    for (const i of [0, 1, 2]) {
      started.push(calls.start($, { tool: 'Read', file_path: f(i) }))
      await h.clock.advance(100)
    }
    // All three settle at t ≈ 300 ms, 20 ms apart.
    for (const [i, c] of started.entries()) {
      calls.release(c.id, read(i))
      await c.done
      await h.clock.advance(20)
    }
    await ui.redraw()
    for (const i of [0, 1, 2]) await shimmering(ui, f(i), 'read')
    // t = 650: f00 (started 0) is done; f01 (100) and f02 (200) still shimmer.
    await h.clock.set(h.clock.now() + (650 - 360))
    await ui.redraw()
    await settled(ui, f(0))
    await shimmering(ui, f(1), 'read')
    await shimmering(ui, f(2), 'read')
    await h.clock.advance(200)
    await ui.redraw()
    for (const i of [0, 1, 2]) await settled(ui, f(i))
  })

  test('a slow Read stops shimmering as soon as it settles', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 30))
    const c = calls.start($, { tool: 'Read', file_path: f(0) })
    await h.clock.advance(2000)
    calls.release(c.id, read(0))
    await c.done
    await ui.redraw()
    await settled(ui, f(0))
  })
})

describe('lights expiring never move the list', () => {
  const f = (i: number) => `${CWD}/many/f${String(i).padStart(2, '0')}.ts`
  /** Reads files 0..29 one after another (Touched lists them newest first), each settled. */
  async function readAll($: Engine, calls: ReturnType<typeof inFlight>, h: ReturnType<typeof harness>, order: number[]) {
    for (const i of order) {
      const c = calls.start($, { tool: 'Read', file_path: f(i) })
      calls.release(c.id, readResult(f(i), MANY[f(i)]!))
      await c.done
      await h.clock.advance(150)
    }
  }

  test('follow paused, rows lit above, in and below the window: the top row and the drawn rows stay put frame to frame', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 14))
    await ui.press({ key: 'tab:touched' })
    await readAll($, calls, h, Array.from({ length: 30 }, (_, i) => i))
    await h.clock.advance(3000)
    // A scroll by hand pauses follow; then reads light rows: the newest go to the top (off screen above).
    await $.ui.scroll({ component: 'Pane', requestId: 'ccfiles', offset: 0, by: 12, bodyRows: 14, contentRows: 60, origin: { kind: 'person' } } as never)
    await readAll($, calls, h, [3, 14, 16])
    await ui.redraw()
    const ids = (ls: RowLine[]) => ls.filter((l) => l.id).map((l) => l.id)
    const first = await clientLines(ui)
    expect(ids(first).length).toBeGreaterThan(5)
    for (let frame = 0; frame < 16; frame++) {
      await h.clock.advance(250)
      await ui.redraw()
      const now = await clientLines(ui)
      expect(now).toHaveLength(first.length)
      expect(ids(now)).toEqual(ids(first))
    }
    expect((await screen(ui)).join('\n')).not.toContain('lit off-screen')
    expect((await screen(ui)).some((l) => /^⋮ \d+ more\s*$/.test(l))).toBe(true)
  })

  test('rows in flight off screen are counted on the one fixed `⋮ N more · M active` line, not pinned as rows', async ($, on) => {
    const h = harness(on, DISK)
    host(on)
    const calls = inFlight(on)
    await startSession($)
    const ui = await $.ui.mount(pane(60, 14))
    await ui.press({ key: 'tab:touched' })
    await readAll($, calls, h, Array.from({ length: 30 }, (_, i) => i))
    await h.clock.advance(3000)
    await $.ui.scroll({ component: 'Pane', requestId: 'ccfiles', offset: 0, by: 100, bodyRows: 14, contentRows: 60, origin: { kind: 'person' } } as never)
    await ui.redraw()
    const before = (await clientLines(ui)).filter((l) => l.id).map((l) => l.id)
    // Re-reads of the three newest files (top of Touched, scrolled away).
    for (const i of [27, 28, 29]) calls.start($, { tool: 'Read', file_path: f(i) })
    await h.clock.settle()
    await ui.redraw()
    const lines = (await screen(ui)).map((l) => l.trim())
    expect(lines.filter((l) => /^⋮ \d+ more · 3 active$/.test(l))).toHaveLength(1)
    // Not pinned as rows (the footer chip names the latest one in words, so only the list is checked).
    expect((await clientLines(ui)).some((l) => /f2[789]\.ts/.test(lineText(l)))).toBe(false)
    // The rows above the note did not move.
    const after = (await clientLines(ui)).filter((l) => l.id).map((l) => l.id)
    expect(after).toEqual(before.slice(0, after.length))
    await calls.releaseAll()
  })
})

void SMALL
