// Gutter badges, the agents line, its expanded list and the viewpoint step, pure.
import { describe, expect, test } from 'claude-code/testing'
import { MAIN } from '../src/agents.ts'
import { makeEvent, type FvEvent, type LogRecord } from '../src/model.ts'
import { replay } from '../src/reducer.ts'
import { agentInfos, agentList, agentListNameWidth, agentListRowSegments, agentsLine, badgeFor, fileBadge, nextViewpoint, type AgentInfo, type AgentSeg } from '../src/view/agentsline.ts'
import { cellWidth } from '../src/view/text.ts'
import { unmarkedTokenFigures } from '../src/tokens.ts'

const text = (segs: readonly AgentSeg[]) => segs.map((s) => s.text).join('')

let seq = 0
/** A subagent; `n` is its place among agents of its type (the registry's `#n`). */
function ag(type: string, n: number, status: 'running' | 'done', o: { end?: number; est?: number; files?: string[]; description?: string } = {}): AgentInfo {
  seq += 1
  return { key: `id-${type}-${n}`, type, label: `${type}#${n}`, status, end: status === 'done' ? (o.end ?? seq) : null, files: o.files ?? [`/p/${type}-${n}.ts`], estTokens: o.est ?? 1000, description: o.description ?? null }
}
const main = (est = 5000): AgentInfo => ({ key: MAIN, type: 'main', label: 'main', status: null, end: null, files: ['/p/a.ts'], estTokens: est, description: null })

/** 12 subagents, 2 running (db-migrator, then Explore#7). */
function twelve(): AgentInfo[] {
  const explores = [1, 2, 3, 4, 5, 6, 8].map((n) => ag('Explore', n, 'done', { end: 100 + n, est: 2000 }))
  return [
    main(5000),
    ag('db-migrator', 1, 'running', { est: 3000 }),
    ...explores.slice(0, 6),
    ag('Explore', 7, 'running', { est: 4000 }),
    explores[6]!,
    ag('general-purpose', 1, 'done', { end: 50, est: 1000 }),
    ag('general-purpose', 2, 'done', { end: 60, est: 1000 }),
    ag('Plan', 1, 'done', { end: 200, est: 1000 }),
  ]
}

describe('gutter badge', () => {
  const t = (key: string, type: string) => ({ key, type })
  test('one other type → its letter, however many agents: E, G, P, C', () => {
    expect(badgeFor([t(MAIN, 'main'), t('e1', 'Explore'), t('e2', 'Explore')], MAIN)).toBe('E')
    expect(badgeFor([t('e1', 'Explore'), t('e2', 'Explore'), t('e3', 'Explore'), t('e4', 'Explore'), t('e5', 'Explore'), t('e6', 'Explore')], MAIN)).toBe('E')
    expect(badgeFor([t('g', 'general-purpose')], MAIN)).toBe('G')
    expect(badgeFor([t('p', 'Plan')], MAIN)).toBe('P')
    expect(badgeFor([t('c', 'db-migrator')], MAIN)).toBe('C')
  })
  test('two or more types → +; two different custom agents are one kind (C)', () => {
    expect(badgeFor([t('e', 'Explore'), t('p', 'Plan')], MAIN)).toBe('+')
    expect(badgeFor([t('c1', 'db-migrator'), t('c2', 'linter')], MAIN)).toBe('C')
  })
  test('only the viewpoint touched it, or nobody → no badge', () => {
    expect(badgeFor([t(MAIN, 'main')], MAIN)).toBeNull()
    expect(badgeFor([], MAIN)).toBeNull()
    expect(badgeFor([t('e1', 'Explore')], 'e1')).toBeNull()
  })
  test('in a subagent viewpoint main counts as m, and as a kind of its own', () => {
    expect(badgeFor([t(MAIN, 'main'), t('e1', 'Explore')], 'e1')).toBe('m')
    expect(badgeFor([t(MAIN, 'main'), t('e1', 'Explore'), t('e2', 'Explore')], 'e1')).toBe('+')
    expect(badgeFor([t(MAIN, 'main'), t('e2', 'Explore')], 'e1')).toBe('+')
  })
})

const ev = (e: Partial<FvEvent> & Pick<FvEvent, 'kind' | 'path'>): LogRecord => ({ t: 'event', e: makeEvent({ source: 'tool', tool: 'Read', ...e }) })
const SESSION: LogRecord[] = [
  { t: 'agent', ts: 1, agentId: 'x1', agentType: 'Explore', description: 'map the repo' },
  { t: 'agent', ts: 2, agentId: 'x2', agentType: 'Explore' },
  { t: 'agent', ts: 3, agentId: 'fork', agentType: '', internal: true },
  ev({ kind: 'read', path: '/p/big.md', ranges: [[1, 300]], totalLines: 500, estTokens: 1200, agentId: 'x1', agentType: 'Explore' }),
  ev({ kind: 'read', path: '/p/big.md', ranges: [[200, 500]], totalLines: 500, estTokens: 1300, agentId: 'x2', agentType: 'Explore' }),
  ev({ kind: 'read', path: '/p/small.ts', ranges: [[1, 10]], totalLines: 10, estTokens: 40 }),
  ev({ kind: 'read', path: '/p/both.ts', ranges: [[1, 10]], totalLines: 10, estTokens: 40 }),
  ev({ kind: 'read', path: '/p/both.ts', ranges: [[1, 10]], totalLines: 10, estTokens: 40, agentId: 'x1', agentType: 'Explore' }),
  { t: 'agent', ts: 9, agentId: 'x1', agentType: 'Explore', stop: true },
]

describe('badges and agents from the session state', () => {
  test('two Explores on big.md show one E from main; small.ts has none; from Explore#1, both.ts carries m', () => {
    const s = replay(SESSION)
    expect(fileBadge(s.files.get('/p/big.md')!, s, MAIN)).toBe('E')
    expect(fileBadge(s.files.get('/p/small.ts')!, s, MAIN)).toBeNull()
    expect(fileBadge(s.files.get('/p/both.ts')!, s, 'x1')).toBe('m')
    expect(fileBadge(s.files.get('/p/big.md')!, s, 'x1')).toBe('E')
  })
  test('agentInfos: main then the registry in order, forks left out, with files, ≈ tokens, status and task', () => {
    const infos = agentInfos(replay(SESSION))
    expect(infos.map((a) => [a.key, a.type, a.label, a.status])).toEqual([
      [MAIN, 'main', 'main', null],
      ['x1', 'Explore', 'Explore#1', 'done'],
      ['x2', 'Explore', 'Explore#2', 'running'],
    ])
    expect(infos[1]).toMatchObject({ files: ['/p/big.md', '/p/both.ts'], estTokens: 1240, description: 'map the repo', end: 9 })
    expect(infos[0]!.files).toEqual(['/p/small.ts', '/p/both.ts'])
  })
})

describe('viewpoint step', () => {
  test('main → each subagent in registry order → main; there is no all mode', () => {
    const subs = ['x1', 'x2', 'x3']
    const seen = [MAIN]
    for (let i = 0; i < 4; i++) seen.push(nextViewpoint(seen[seen.length - 1]!, subs))
    expect(seen).toEqual([MAIN, 'x1', 'x2', 'x3', MAIN])
    expect(seen).not.toContain('all')
  })
  test('a viewpoint that no longer exists, or no subagents at all, lands on main', () => {
    expect(nextViewpoint('gone', ['x1'])).toBe(MAIN)
    expect(nextViewpoint(MAIN, [])).toBe(MAIN)
    expect(nextViewpoint('x1', [MAIN, 'x1'])).toBe(MAIN)
  })
})

describe('collapsed agents line', () => {
  test('no agents line without a subagent', () => {
    expect(agentsLine([main()], { width: 60, viewpoint: MAIN })).toBeNull()
  })

  const cases: [string, () => AgentInfo[]][] = [
    ['1 agent', () => [main(), ag('Explore', 1, 'running')]],
    ['3 agents', () => [main(), ag('Explore', 1, 'done', { end: 10 }), ag('db-migrator', 1, 'running'), ag('Plan', 1, 'done', { end: 20 })]],
    ['12 agents (2 running)', twelve],
  ]
  for (const [name, make] of cases) {
    for (const width of [39, 60, 100]) {
      test(`${name} at ${width}: one line of exactly the width; running first, then finished, then +N done; ≈ total at the right`, () => {
        const agents = make()
        const segs = agentsLine(agents, { width, viewpoint: MAIN })!
        const line = text(segs)
        expect(cellWidth(line)).toBe(width)
        expect(line).not.toContain('\n')
        expect(line.startsWith('▸ main')).toBe(true)
        const total = agents.reduce((n, a) => n + a.estTokens, 0)
        expect(line.endsWith(`≈${total >= 10_000 ? Math.round(total / 1000) + 'k' : (total / 1000).toFixed(1).replace(/\.0$/, '') + 'k'}`)).toBe(true)
        // Every agent is shown by name or counted in a +N fold, exactly once.
        const shown = segs.filter((s) => s.role === 'name').map((s) => s.key!)
        const folded = segs.filter((s) => s.role === 'more').reduce((n, s) => n + Number(/\+(\d+)/.exec(s.text)![1]), 0)
        expect(shown.length + folded).toBe(agents.length - 1)
        // Running agents come before finished ones.
        const statuses = shown.map((k) => agents.find((a) => a.key === k)!.status)
        expect(statuses.join(',')).toMatch(/^(running,)*(running|done)?(,done)*$/)
        // A finished agent is folded only when it didn't fit: the running ones are all shown before any `+N running`.
        if (segs.some((s) => s.role === 'more' && s.text.includes('running'))) expect(statuses).not.toContain('done')
        expect(unmarkedTokenFigures(line)).toEqual([])
      })
    }
  }

  test('12 subagents with 2 running at 60 columns', () => {
    expect(text(agentsLine(twelve(), { width: 60, viewpoint: MAIN })!)).toBe('▸ main · C db-migrator ◌ · E Explore#7 ◌ · +10 done     ≈29k')
  })
  test('wide enough, finished agents follow, most recently finished first', () => {
    const line = text(agentsLine(twelve(), { width: 100, viewpoint: MAIN })!)
    expect(line).toMatch(/^▸ main · C db-migrator ◌ · E Explore#7 ◌ · P Plan ✓ · E Explore#8 ✓ · E Explore#6 ✓ · .*\+\d+ done +≈29k$/)
  })
  test('at 39 columns the running agents still lead; the fold drops its words before a name goes', () => {
    expect(text(agentsLine(twelve(), { width: 39, viewpoint: MAIN })!)).toBe('▸ main · C db-migrator ◌ · +11     ≈29k')
  })
  test('a lone agent of its type drops #1; repeated types keep #n', () => {
    const line = text(agentsLine([main(), ag('db-migrator', 1, 'running'), ag('Explore', 1, 'done'), ag('Explore', 2, 'done')], { width: 100, viewpoint: MAIN })!)
    expect(line).toContain('C db-migrator ◌')
    expect(line).toContain('E Explore#1 ✓')
  })
  test('the viewpoint agent is always shown, first, and marked selected; clicks map to agent keys', () => {
    const agents = twelve()
    const vp = agents.find((a) => a.label === 'general-purpose#1')!.key
    const segs = agentsLine(agents, { width: 60, viewpoint: vp })!
    const names = segs.filter((s) => s.role === 'name')
    expect(names[0]).toMatchObject({ key: vp, selected: true, text: 'general-purpose#1' })
    expect(segs.find((s) => s.role === 'main')).toMatchObject({ key: MAIN })
    expect(segs.find((s) => s.role === 'main')!.selected).toBeUndefined()
  })
  test('expanded, the caret turns', () => {
    expect(text(agentsLine(twelve(), { width: 60, viewpoint: MAIN, expanded: true })!).startsWith('▾ main')).toBe(true)
  })
  test('very narrow: still exactly the width', () => {
    for (const w of [8, 12, 20]) expect(cellWidth(text(agentsLine(twelve(), { width: w, viewpoint: MAIN })!))).toBe(w)
  })
})

describe('expanded list', () => {
  const none = new Set<string>()
  test('main, then running agents pinned at the top, then finished; six finished Explores fold into one ×6 row', () => {
    const agents = [
      main(),
      ...[1, 2, 3, 4, 5, 6].map((n) => ag('Explore', n, 'done', { end: n, est: 2000, files: ['/p/shared.ts', `/p/e${n}.ts`] })),
      ag('db-migrator', 1, 'running', { description: 'migrate users table' }),
      ag('Explore', 7, 'running'),
    ]
    const list = agentList(agents, { bodyHeight: 60, scroll: 0, open: none, viewpoint: MAIN })
    expect(list.rows.map((r) => (r.kind === 'group' ? `group ${r.name} ×${r.count}` : r.name))).toEqual(['main', 'db-migrator', 'Explore#7', 'group Explore ×6'])
    const g = list.rows[3]!
    expect(cellWidth(text(agentListRowSegments(g, 60)))).toBe(60)
    // Columns (status, files right-aligned in 10, ≈ tokens in 8) line up down the list.
    expect(text(agentListRowSegments(g, 60)).trimEnd().replace(/ +/g, ' ')).toBe('E Explore ×6 ✓ 7 files ≈12k')
  })
  test('an open group lists its six instances under it', () => {
    const agents = [main(), ...[1, 2, 3, 4, 5, 6].map((n) => ag('Explore', n, 'done', { end: n }))]
    const list = agentList(agents, { bodyHeight: 60, scroll: 0, open: new Set(['Explore']), viewpoint: MAIN })
    expect(list.rows).toHaveLength(8)
    expect(list.rows[1]).toMatchObject({ kind: 'group', open: true, count: 6 })
    const instances = list.rows.slice(2)
    expect(instances.map((r) => r.kind === 'agent' && r.indent)).toEqual([1, 1, 1, 1, 1, 1])
    expect(instances.map((r) => r.name)).toEqual(['Explore#6', 'Explore#5', 'Explore#4', 'Explore#3', 'Explore#2', 'Explore#1'])
    expect(text(agentListRowSegments(instances[0]!, 40)).startsWith('  E Explore#6 ✓')).toBe(true)
  })
  test('a single finished agent of a type keeps its own row', () => {
    const list = agentList([main(), ag('Plan', 1, 'done'), ag('Explore', 1, 'done')], { bodyHeight: 60, scroll: 0, open: none, viewpoint: MAIN })
    expect(list.rows.map((r) => r.kind)).toEqual(['agent', 'agent', 'agent'])
  })
  test('a custom agent shows its full name and (custom), with files, ≈ tokens and its task', () => {
    const list = agentList([main(), ag('db-migrator', 1, 'running', { est: 3400, files: ['/p/a', '/p/b'], description: 'migrate users table' })], { bodyHeight: 60, scroll: 0, open: none, viewpoint: MAIN })
    const row = list.rows[1]!
    expect(text(agentListRowSegments(row, 80)).trimEnd().replace(/ +/g, ' ')).toBe('C db-migrator (custom) ◌ 2 files ≈3.4k migrate users table')
    const narrow = text(agentListRowSegments(row, 30))
    expect(cellWidth(narrow)).toBe(30)
    expect(narrow.endsWith('…')).toBe(true)
  })
  test('at most ⌊body/3⌋ rows, scrolling on its own; the offset is clamped and says what lies above and below', () => {
    const agents = [main(), ...Array.from({ length: 10 }, (_, i) => ag(`custom-${i}`, 1, 'running'))]
    const top = agentList(agents, { bodyHeight: 20, scroll: 0, open: none, viewpoint: MAIN })
    expect(top).toMatchObject({ cap: 6, total: 11, offset: 0, above: false, below: true })
    expect(top.rows).toHaveLength(6)
    const mid = agentList(agents, { bodyHeight: 20, scroll: 3, open: none, viewpoint: MAIN })
    expect(mid).toMatchObject({ offset: 3, above: true, below: true })
    expect(mid.rows[0]!.name).toBe('custom-2')
    const end = agentList(agents, { bodyHeight: 20, scroll: 99, open: none, viewpoint: MAIN })
    expect(end).toMatchObject({ offset: 5, above: true, below: false })
    expect(agentList(agents, { bodyHeight: 20, scroll: -4, open: none, viewpoint: MAIN }).offset).toBe(0)
  })
  test('a short list fits whole', () => {
    expect(agentList([main(), ag('Plan', 1, 'running')], { bodyHeight: 30, scroll: 5, open: none, viewpoint: MAIN })).toMatchObject({ total: 2, offset: 0, above: false, below: false })
  })
  test('the viewpoint row is marked; a closed group holding it is too', () => {
    const agents = [main(), ag('Explore', 1, 'done', { end: 1 }), ag('Explore', 2, 'done', { end: 2 })]
    const list = agentList(agents, { bodyHeight: 30, scroll: 0, open: none, viewpoint: agents[1]!.key })
    expect(list.rows.map((r) => r.selected)).toEqual([false, true])
  })
})

describe('expanded list columns line up', () => {
  test('status, files and ≈ tokens end at the same columns on every row', () => {
    const rows = [
      { kind: 'agent' as const, key: 'a', badge: 'E' as const, name: 'Explore#1', custom: false, status: 'done' as const, files: 3, estTokens: 7600, description: 'x', indent: 0 as const, selected: false },
      { kind: 'agent' as const, key: 'b', badge: 'C' as const, name: 'db-migrator', custom: true, status: 'running' as const, files: 12, estTokens: 341, description: null, indent: 0 as const, selected: false },
    ]
    const name = agentListNameWidth(rows)
    const lines = rows.map((r) => text(agentListRowSegments(r, 80, { name })))
    const end = (l: string, re: RegExp) => { const m = re.exec(l)!; return m.index + m[0].length }
    expect(end(lines[0]!, /files/)).toBe(end(lines[1]!, /files/))
    expect(end(lines[0]!, /≈[\d.k]+/)).toBe(end(lines[1]!, /≈[\d.k]+/))
  })
})
