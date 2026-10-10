// Root resolution, section order, labels and focus helpers, pure.
import { describe, expect, test } from 'claude-code/testing'
import { additionalDirectories, breadcrumb, fitBreadcrumb, focusRepo, gitDirsToResolve, homeShort, isUnder, parentFocus, parseRevParse, resolveRoot, revParseArgv, sectionLabel, sectionRepo, sections, settingsFiles, type RootContext } from '../src/roots.ts'
import { cellWidth } from '../src/view/text.ts'

const HOME = '/Users/j'
const SESSION = `${HOME}/Projects/acme-web-app`

/** A context with no added dirs, no git answers and no markers unless a test gives them. */
function ctx(over: { added?: string[]; git?: Record<string, string | null>; markers?: string[] } = {}): RootContext {
  return {
    sessionRoot: SESSION,
    home: HOME,
    addedDirs: over.added ?? [],
    gitTopLevel: (dir) => (over.git && dir in over.git ? over.git[dir] : undefined),
    hasMarker: (dir) => (over.markers ?? []).includes(dir),
  }
}

describe('resolveRoot: first match wins', () => {
  const file = `${HOME}/Projects/other/packages/a/src/x.ts`
  const everything = {
    added: [`${HOME}/Projects/other/packages`],
    git: { [`${HOME}/Projects/other/packages/a/src`]: `${HOME}/Projects/other` },
    markers: [`${HOME}/Projects/other/packages/a`],
  }

  test('a DirectoryAdded / additionalDirectories directory wins over git, markers and the parent', () => {
    expect(resolveRoot(file, ctx(everything))).toEqual({ root: `${HOME}/Projects/other/packages`, via: 'added', provisional: false })
  })
  test('else the git top level of the path\'s directory', () => {
    expect(resolveRoot(file, ctx({ ...everything, added: [] }))).toEqual({ root: `${HOME}/Projects/other`, via: 'git', provisional: false })
  })
  test('else the nearest ancestor holding package.json / Cargo.toml / pyproject.toml / go.mod', () => {
    const r = resolveRoot(file, ctx({ markers: everything.markers, git: { [`${HOME}/Projects/other/packages/a/src`]: null } }))
    expect(r).toEqual({ root: `${HOME}/Projects/other/packages/a`, via: 'marker', provisional: false })
  })
  test('the nearest marker wins over a farther one', () => {
    const r = resolveRoot(file, ctx({ markers: [`${HOME}/Projects/other`, `${HOME}/Projects/other/packages/a`] }))
    expect(r?.root).toBe(`${HOME}/Projects/other/packages/a`)
  })
  test('else the file\'s parent directory', () => {
    expect(resolveRoot('/tmp/loose/notes.txt', ctx({ git: { '/tmp/loose': null } }))).toEqual({ root: '/tmp/loose', via: 'parent', provisional: false })
  })
  test('while git hasn\'t answered for the directory, steps 3–4 stand in and say so', () => {
    expect(resolveRoot('/tmp/loose/notes.txt', ctx())).toEqual({ root: '/tmp/loose', via: 'parent', provisional: true })
  })
  test('the session root wins for paths under it, even inside an added directory or another repo', () => {
    const c = ctx({ added: [`${HOME}/Projects`], git: { [`${SESSION}/src`]: `${HOME}/Projects` } })
    expect(resolveRoot(`${SESSION}/src/a.ts`, c)).toEqual({ root: SESSION, via: 'session', provisional: false })
  })
  test('the deepest added directory wins when two hold the path', () => {
    const r = resolveRoot(file, ctx({ added: [`${HOME}/Projects/other`, `${HOME}/Projects/other/packages`] }))
    expect(r?.root).toBe(`${HOME}/Projects/other/packages`)
  })
  test('files under ~/.claude/ never make a section', () => {
    const c = ctx({ git: { [`${HOME}/.claude`]: `${HOME}/.claude` }, markers: [`${HOME}/.claude`] })
    expect(resolveRoot(`${HOME}/.claude/CLAUDE.md`, c)).toBeNull()
    expect(resolveRoot(`${HOME}/.claude/projects/p/memory/MEMORY.md`, c)).toBeNull()
    expect(resolveRoot(`${HOME}/.claudex/a.md`, ctx())?.root).toBe(`${HOME}/.claudex`)
  })
  test('home and / are never a root: a dotfiles repo at ~ or a stray ~/package.json don\'t swallow everything', () => {
    const c = ctx({ git: { [`${HOME}/notes`]: HOME }, markers: [HOME] })
    expect(resolveRoot(`${HOME}/notes/a.md`, c)).toEqual({ root: `${HOME}/notes`, via: 'parent', provisional: false })
  })
})

describe('git root lookups', () => {
  test('only directories git hasn\'t answered for, each once; session, added and ~/.claude/ paths need none', () => {
    const c = ctx({ added: ['/srv/added'], git: { '/tmp/known': '/tmp/known' } })
    const dirs = gitDirsToResolve(
      [`${SESSION}/a.ts`, '/srv/added/b.ts', `${HOME}/.claude/CLAUDE.md`, '/tmp/known/c.ts', '/tmp/new/d.ts', '/tmp/new/e.ts', '/opt/z/f.ts'],
      c,
    )
    expect(dirs).toEqual(['/tmp/new', '/opt/z'])
  })
  test('a cached "not a repo" (null) is an answer too', () => {
    expect(gitDirsToResolve(['/tmp/plain/a.txt'], ctx({ git: { '/tmp/plain': null } }))).toEqual([])
  })
  test('the argv asks for the top level and the directory\'s prefix inside it', () => {
    expect(revParseArgv('/tmp/fv-other/src')).toEqual(['git', '-C', '/tmp/fv-other/src', 'rev-parse', '--show-toplevel', '--show-prefix'])
  })
  test('the answer keeps the session\'s spelling of a symlinked path (/tmp vs /private/tmp)', () => {
    expect(parseRevParse('/tmp/fv-other/src', { exitCode: 0, stdout: '/private/tmp/fv-other\nsrc/\n' })).toBe('/tmp/fv-other')
    expect(parseRevParse('/tmp/fv-other', { exitCode: 0, stdout: '/private/tmp/fv-other\n\n' })).toBe('/tmp/fv-other')
  })
  test('a failed run or no output means not a repo', () => {
    expect(parseRevParse('/tmp/x', { exitCode: 128, stdout: '' })).toBeNull()
    expect(parseRevParse('/tmp/x', null)).toBeNull()
    expect(parseRevParse('/tmp/x', { exitCode: 0, stdout: '' })).toBeNull()
  })
  test('a parsed answer feeds resolveRoot as the git step', () => {
    const top = parseRevParse('/tmp/fv-other/src', { exitCode: 0, stdout: '/private/tmp/fv-other\nsrc/\n' })
    expect(resolveRoot('/tmp/fv-other/src/x.ts', ctx({ git: { '/tmp/fv-other/src': top } }))?.root).toBe('/tmp/fv-other')
  })
})

describe('sections', () => {
  test('the session root first, then outside roots in order of first touch, each with its files', () => {
    const c = ctx({ git: { '/tmp/fv-other/src': '/tmp/fv-other', [`${HOME}/Projects/lib`]: `${HOME}/Projects/lib` } })
    const out = sections(['/tmp/fv-other/src/x.ts', `${SESSION}/a.ts`, `${HOME}/Projects/lib/b.ts`, '/tmp/fv-other/src/y.ts', `${SESSION}/b.ts`], c)
    expect(out).toEqual([
      { root: SESSION, via: 'session', files: [`${SESSION}/a.ts`, `${SESSION}/b.ts`] },
      { root: '/tmp/fv-other', via: 'git', files: ['/tmp/fv-other/src/x.ts', '/tmp/fv-other/src/y.ts'] },
      { root: `${HOME}/Projects/lib`, via: 'git', files: [`${HOME}/Projects/lib/b.ts`] },
    ])
  })
  test('the session root is listed even before anything is touched', () => {
    expect(sections([], ctx())).toEqual([{ root: SESSION, via: 'session', files: [] }])
  })
  test('~/.claude/ files are left out of every section', () => {
    const out = sections([`${HOME}/.claude/CLAUDE.md`, `${SESSION}/a.ts`], ctx())
    expect(out.flatMap((s) => s.files)).toEqual([`${SESSION}/a.ts`])
  })
  test('a root inside another outside root folds into the outer one, at the earlier position', () => {
    // git hasn't answered for /tmp/x/src yet (provisional parent rule); it has for /tmp/x, touched later.
    const nested = ctx({ git: { '/tmp/x': '/tmp/x', '/tmp/y': null } })
    const out = sections(['/tmp/x/src/a.ts', '/tmp/y/b.ts', '/tmp/x/c.ts'], nested)
    expect(out.map((s) => [s.root, s.files])).toEqual([
      [SESSION, []],
      ['/tmp/x', ['/tmp/x/src/a.ts', '/tmp/x/c.ts']],
      ['/tmp/y', ['/tmp/y/b.ts']],
    ])
    expect(out[1]!.via).toBe('git')
  })
})

describe('labels', () => {
  test('home-shortened under ~, unchanged elsewhere', () => {
    expect(homeShort(`${HOME}/Projects/other-repo`, HOME)).toBe('~/Projects/other-repo')
    expect(homeShort(HOME, HOME)).toBe('~')
    expect(homeShort('/tmp/fv-other', HOME)).toBe('/tmp/fv-other')
    expect(homeShort('/Users/jx/a', HOME)).toBe('/Users/jx/a')
  })
  test('a section label is middle-truncated to the width, keeping both ends', () => {
    const label = sectionLabel(`${HOME}/Projects/some-very-long-repository-name`, HOME, 20)
    expect(cellWidth(label)).toBe(20)
    expect(label.startsWith('~/Pro')).toBe(true)
    expect(label.endsWith('name')).toBe(true)
    expect(label).toContain('…')
    expect(sectionLabel('/tmp/fv-other', HOME, 40)).toBe('/tmp/fv-other')
  })
})

describe('focus helpers', () => {
  test('isUnder: the directory itself and anything inside it, not a sibling sharing a prefix', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
    expect(isUnder('/a/b/c.ts', '/a/b/')).toBe(true)
    expect(isUnder('/a/bc', '/a/b')).toBe(false)
    expect(isUnder('/a', '/')).toBe(true)
  })
  test('breadcrumb under the session root starts with its name', () => {
    expect(breadcrumb(`${SESSION}/packages/api-layer`, SESSION, HOME)).toEqual(['acme-web-app', 'packages', 'api-layer'])
    expect(breadcrumb(SESSION, SESSION, HOME)).toEqual(['acme-web-app'])
  })
  test('breadcrumb in an outside section starts with its home-shortened root', () => {
    expect(breadcrumb('/tmp/fv-other/src', SESSION, HOME, ['/tmp/fv-other'])).toEqual(['/tmp/fv-other', 'src'])
    expect(breadcrumb(`${HOME}/Projects/lib`, SESSION, HOME, [`${HOME}/Projects/lib`])).toEqual(['~/Projects/lib'])
  })
  test('breadcrumb above the session root is the path itself', () => {
    expect(breadcrumb(`${HOME}/Projects`, SESSION, HOME)).toEqual(['~', 'Projects'])
    expect(breadcrumb('/tmp', SESSION, HOME)).toEqual(['/', 'tmp'])
  })
  test('↑ walks up past the session root to /, then stops', () => {
    const seen: string[] = []
    for (let f: string | null = `${SESSION}/packages`; f !== null; f = parentFocus(f)) seen.push(f)
    expect(seen).toEqual([`${SESSION}/packages`, SESSION, `${HOME}/Projects`, HOME, '/Users', '/'])
  })
  test('fitBreadcrumb keeps the whole path when it fits, else folds the middle, always keeping the last segment', () => {
    const segs = ['acme-web-app', 'packages', 'core', 'api-layer']
    expect(fitBreadcrumb(segs, 60)).toBe('acme-web-app ▸ packages ▸ core ▸ api-layer')
    expect(fitBreadcrumb(segs, 30)).toBe('acme-web-app ▸ … ▸ api-layer')
    expect(fitBreadcrumb(segs, 15)).toBe('… ▸ api-layer')
    expect(fitBreadcrumb(segs, 9)).toBe('api-layer')
    const tiny = fitBreadcrumb(segs, 6)
    expect(cellWidth(tiny)).toBeLessThanOrEqual(6)
    expect(tiny.endsWith('er')).toBe(true)
  })
})

describe('permissions.additionalDirectories from settings files', () => {
  test('the project settings, its local settings, then the user settings in the config dir', () => {
    expect(settingsFiles(SESSION, `${HOME}/.claude`)).toEqual([`${SESSION}/.claude/settings.json`, `${SESSION}/.claude/settings.local.json`, `${HOME}/.claude/settings.json`])
    expect(settingsFiles(SESSION, null)).toEqual([`${SESSION}/.claude/settings.json`, `${SESSION}/.claude/settings.local.json`])
  })
  test('absolute, ~ and relative entries become absolute directories, each once', () => {
    const text = JSON.stringify({ permissions: { additionalDirectories: ['/work/shared/', '~/Projects/lib', '../docs', '/work/shared', 7, ''] } })
    expect(additionalDirectories(text, SESSION, HOME)).toEqual(['/work/shared', `${HOME}/Projects/lib`, `${HOME}/Projects/docs`])
  })
  test('a missing file, bad JSON or another shape gives none and never throws', () => {
    expect(additionalDirectories(null, SESSION, HOME)).toEqual([])
    expect(additionalDirectories('{ not json', SESSION, HOME)).toEqual([])
    expect(additionalDirectories(JSON.stringify({ permissions: { additionalDirectories: '/x' } }), SESSION, HOME)).toEqual([])
    expect(additionalDirectories(JSON.stringify(['x']), SESSION, HOME)).toEqual([])
  })
  test('an added directory from settings roots an outside file like a DirectoryAdded one', () => {
    const added = additionalDirectories(JSON.stringify({ permissions: { additionalDirectories: ['/work/shared'] } }), SESSION, HOME)
    expect(resolveRoot('/work/shared/pkg/a.ts', ctx({ added, git: { '/work/shared/pkg': '/work/shared/pkg' } }))).toMatchObject({ root: '/work/shared', via: 'added' })
  })
})

describe('the repo a section or focus shows', () => {
  const git = (answers: Record<string, string | null>) => (dir: string) => (dir in answers ? answers[dir] : undefined)
  test('a git-rooted section is its own repo; marker and parent roots are none', () => {
    expect(sectionRepo({ root: '/tmp/fv-other', via: 'git' }, git({}))).toBe('/tmp/fv-other')
    expect(sectionRepo({ root: '/work/m', via: 'marker' }, git({}))).toBe(null)
    expect(sectionRepo({ root: '/work/p', via: 'parent' }, git({}))).toBe(null)
  })
  test('an added directory asks git about itself: not yet, a repo, or none', () => {
    expect(sectionRepo({ root: '/work/shared', via: 'added' }, git({}))).toBe(undefined)
    expect(sectionRepo({ root: '/work/shared', via: 'added' }, git({ '/work/shared': '/work' }))).toBe('/work')
    expect(sectionRepo({ root: '/work/shared', via: 'added' }, git({ '/work/shared': null }))).toBe(null)
  })
  test('a focus inside a section takes its repo; elsewhere the focus folder\'s own answer', () => {
    const secs = [{ root: '/tmp/fv-other', via: 'git' as const }]
    expect(focusRepo('/tmp/fv-other/src', secs, git({}))).toBe('/tmp/fv-other')
    expect(focusRepo('/tmp', secs, git({ '/tmp': null }))).toBe(null)
    expect(focusRepo('/tmp', secs, git({}))).toBe(undefined)
    expect(focusRepo('/srv/repo/a', secs, git({ '/srv/repo/a': '/srv/repo' }))).toBe('/srv/repo')
  })
})

describe('sections at scale', () => {
  // The merge before the fix: for every outside file, the outermost of all outside roots holding its root.
  function naive(paths: readonly string[], c: RootContext) {
    const outside: { path: string; root: string; via: string }[] = []
    for (const path of paths) {
      const r = resolveRoot(path, c)
      if (r && r.via !== 'session') outside.push({ path, root: r.root, via: r.via })
    }
    const roots = outside.map((o) => o.root)
    const merged = new Map<string, { root: string; via: string; files: string[] }>()
    for (const o of outside) {
      const top = roots.filter((r) => isUnder(o.root, r)).sort((a, b) => a.length - b.length)[0]!
      let s = merged.get(top)
      if (!s) merged.set(top, (s = { root: top, via: outside.find((x) => x.root === top)!.via, files: [] }))
      s.files.push(o.path)
    }
    return [...merged.values()]
  }

  test('5,000 outside files across 50 roots take well under a second and give the same sections', () => {
    const git: Record<string, string | null> = {}
    const paths: string[] = []
    for (let j = 0; j < 5000; j++) {
      const i = j % 50
      // Most files sit in a repo; every seventh in a package folder git hasn't answered for (a nested parent root).
      const dir = j % 7 === 0 ? `/work/r${i}/pkg/p${j % 3}` : `/work/r${i}/src/d${j % 5}`
      if (j % 7 !== 0) git[dir] = `/work/r${i}`
      paths.push(`${dir}/f${j}.ts`)
    }
    paths.splice(2500, 0, `${SESSION}/a.ts`)
    const c = ctx({ git })
    const t0 = performance.now()
    const out = sections(paths, c)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(500)
    expect(out.length).toBe(51)
    expect(out.reduce((n, s) => n + s.files.length, 0)).toBe(paths.length)
    // The naive reference is itself quadratic: compare on a slice that still covers every root and nested folder.
    const some = paths.slice(0, 600)
    expect(sections(some, c).slice(1)).toEqual(naive(some, c) as never)
  })
})

describe('roots never contain the session root', () => {
  // A package of a monorepo: the session runs in /m/pkg, the repo and its package.json are at /m.
  const mono = (over: { added?: string[]; git?: Record<string, string | null>; markers?: string[] }): RootContext => ({ ...ctx(over), sessionRoot: '/m/pkg' })

  test('a git top level holding the session root is passed over; so is a marker there', () => {
    const c = mono({ git: { '/m': '/m', '/m/other/src': '/m' }, markers: ['/m', '/m/other'] })
    expect(resolveRoot('/m/other/src/x.ts', c)).toEqual({ root: '/m/other', via: 'marker', provisional: false })
  })
  test('an added directory holding the session root is passed over', () => {
    const c = mono({ added: ['/m'], git: { '/m/other/src': null } })
    expect(resolveRoot('/m/other/src/x.ts', c)).toEqual({ root: '/m/other/src', via: 'parent', provisional: false })
  })
  test('a file directly above the session root stays in its folder, which absorbs no other section', () => {
    const c = mono({ git: { '/m': '/m', '/m/other/src': '/m' }, markers: ['/m', '/m/other'] })
    expect(resolveRoot('/m/README.md', c)).toEqual({ root: '/m', via: 'parent', provisional: false })
    const out = sections(['/m/README.md', '/m/other/src/x.ts', '/m/pkg/a.ts'], c)
    expect(out.map((s) => [s.root, s.files])).toEqual([
      ['/m/pkg', ['/m/pkg/a.ts']],
      ['/m', ['/m/README.md']],
      ['/m/other', ['/m/other/src/x.ts']],
    ])
  })
})

describe('home and / never absorb other sections', () => {
  test('~/.zshrc and /hosts keep their own sections; a repo under ~ and a folder under / stay separate', () => {
    const c = ctx({ git: { [HOME]: null, [`${HOME}/Projects/other/src`]: `${HOME}/Projects/other`, '/': null, '/etc': null } })
    const out = sections([`${HOME}/.zshrc`, `${HOME}/Projects/other/src/a.ts`, '/hosts', '/etc/hosts', `${HOME}/.bashrc`], c)
    expect(out.slice(1).map((s) => [s.root, s.files])).toEqual([
      [HOME, [`${HOME}/.zshrc`, `${HOME}/.bashrc`]],
      [`${HOME}/Projects/other`, [`${HOME}/Projects/other/src/a.ts`]],
      ['/', ['/hosts']],
      ['/etc', ['/etc/hosts']],
    ])
  })
})
