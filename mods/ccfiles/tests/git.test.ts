import { describe, expect, test } from 'claude-code/testing'
import {
  commitShaFromBash,
  firstLine,
  GIT_COMMANDS,
  parseAheadBehind,
  parseBranch,
  parseNameOnly,
  parseNumstat,
  parsePorcelain,
  shouldRefresh,
  snapshot,
} from '../src/git.ts'

// Outputs captured from git 2.x in a scratch repo: modify, stage new, git mv, git rm, untracked, ignored, binary.
const ROOT = '/tmp/ccfiles-git-scratch'
const STATUS =
  'A  added.ts\0D  gone.txt\0 M img.bin\0 M keep.txt\0RM src/new/move.ts\0src/old/move.ts\0?? sp ace.txt\0?? untracked.md\0'
const STATUS_IGNORED = STATUS + '!! dist/out.js\0'
const NUMSTAT = '1\t0\tadded.ts\n0\t1\tgone.txt\n-\t-\timg.bin\n2\t1\tkeep.txt\n1\t0\tsrc/{old => new}/move.ts\n'

describe('parsePorcelain', () => {
  test('real -z output: letters, staged flag, rename old path, spaces in names', () => {
    expect(parsePorcelain(STATUS, ROOT)).toEqual([
      { path: `${ROOT}/added.ts`, letter: 'A', staged: true },
      { path: `${ROOT}/gone.txt`, letter: 'D', staged: true },
      { path: `${ROOT}/img.bin`, letter: 'M', staged: false },
      { path: `${ROOT}/keep.txt`, letter: 'M', staged: false },
      { path: `${ROOT}/src/new/move.ts`, letter: 'R', staged: true, origPath: `${ROOT}/src/old/move.ts` },
      { path: `${ROOT}/sp ace.txt`, letter: '?', staged: false },
      { path: `${ROOT}/untracked.md`, letter: '?', staged: false },
    ])
  })

  test('--ignored adds !! entries', () => {
    const files = parsePorcelain(STATUS_IGNORED, ROOT)
    expect(files[files.length - 1]).toEqual({ path: `${ROOT}/dist/out.js`, letter: '!', staged: false })
  })

  test('XY picks one letter: copy → R, worktree delete → D, unmerged and type change → M', () => {
    const out = parsePorcelain('C  b\0a\0 D c\0MD d\0UU e\0 T f\0AM g\0', '/r')
    expect(out.map((f) => [f.path, f.letter, f.staged])).toEqual([
      ['/r/b', 'R', true],
      ['/r/c', 'D', false],
      ['/r/d', 'D', true],
      ['/r/e', 'M', true],
      ['/r/f', 'M', false],
      ['/r/g', 'A', true],
    ])
    expect(out[0]!.origPath).toBe('/r/a')
  })

  test('empty output and unknown codes give no files and never throw', () => {
    expect(parsePorcelain('', ROOT)).toEqual([])
    expect(parsePorcelain('ZZ weird\0garbage\0 M ok\0', '/r')).toEqual([{ path: '/r/ok', letter: 'M', staged: false }])
  })
})

describe('parseNumstat', () => {
  test('real output: counts, binary as 0/0, brace rename keyed by the new path', () => {
    const m = parseNumstat(NUMSTAT, ROOT)
    expect(m.get(`${ROOT}/keep.txt`)).toEqual({ added: 2, removed: 1, binary: false })
    expect(m.get(`${ROOT}/img.bin`)).toEqual({ added: 0, removed: 0, binary: true })
    expect(m.get(`${ROOT}/src/new/move.ts`)).toEqual({ added: 1, removed: 0, binary: false })
    expect(m.has(`${ROOT}/src/old/move.ts`)).toBe(false)
    expect(m.size).toBe(5)
  })

  test('plain `a => b` rename and brace renames with an empty side', () => {
    const m = parseNumstat('2\t1\tkeep.txt => kept.txt\n0\t0\tsrc/{ => sub}/x.ts\n3\t0\tsrc/{sub => }/y.ts\n', '/r')
    expect([...m.keys()]).toEqual(['/r/kept.txt', '/r/src/sub/x.ts', '/r/src/y.ts'])
  })

  test('C-quoted paths (non-ASCII, embedded quote) are unquoted', () => {
    const m = parseNumstat('1\t0\t"t\\303\\251\\"st.txt"\n', '/r')
    expect([...m.keys()]).toEqual(['/r/té"st.txt'])
  })

  test('empty output is an empty map', () => {
    expect(parseNumstat('', ROOT).size).toBe(0)
  })
})

describe('ahead/behind, branch, first line', () => {
  test('left count is behind, right count is ahead', () => {
    expect(parseAheadBehind('2\t1\n')).toEqual({ ahead: 1, behind: 2 })
  })

  test('no upstream (empty) or garbage → null', () => {
    expect(parseAheadBehind('')).toBe(null)
    expect(parseAheadBehind("fatal: no upstream configured for branch 'main'\n")).toBe(null)
  })

  test('branch name, or null when detached', () => {
    expect(parseBranch('main\n')).toBe('main')
    expect(parseBranch('')).toBe(null)
  })

  test('firstLine trims and maps empty to null', () => {
    expect(firstLine('/tmp/ccfiles-git-scratch\n')).toBe('/tmp/ccfiles-git-scratch')
    expect(firstLine('0c0c1f34dee5bd07f1f4ae9cf5ee7113e2c8d8a4\n')).toBe('0c0c1f34dee5bd07f1f4ae9cf5ee7113e2c8d8a4')
    expect(firstLine('  \n')).toBe(null)
  })
})

describe('snapshot', () => {
  test('joins status with numstat; untracked files get 0/0', () => {
    const s = snapshot({
      root: `${ROOT}\n`,
      status: STATUS,
      numstat: NUMSTAT,
      aheadBehind: '',
      branch: 'main\n',
      head: '0c0c1f34dee5bd07f1f4ae9cf5ee7113e2c8d8a4\n',
    })
    expect(s.root).toBe(ROOT)
    expect(s.branch).toBe('main')
    expect(s.head).toBe('0c0c1f34dee5bd07f1f4ae9cf5ee7113e2c8d8a4')
    expect(s.ahead).toBe(null)
    expect(s.behind).toBe(null)
    expect(s.files.size).toBe(7)
    expect(s.files.get(`${ROOT}/src/new/move.ts`)).toEqual({
      path: `${ROOT}/src/new/move.ts`,
      letter: 'R',
      staged: true,
      origPath: `${ROOT}/src/old/move.ts`,
      added: 1,
      removed: 0,
      binary: false,
    })
    expect(s.files.get(`${ROOT}/untracked.md`)).toEqual({
      path: `${ROOT}/untracked.md`,
      letter: '?',
      staged: false,
      added: 0,
      removed: 0,
      binary: false,
    })
  })

  test('ahead/behind flow through when an upstream exists', () => {
    const s = snapshot({ root: '/r', status: '', numstat: '', aheadBehind: '2\t1\n', branch: '', head: '' })
    expect([s.ahead, s.behind, s.branch, s.head, s.files.size]).toEqual([1, 2, null, null, 0])
  })
})

describe('parseNameOnly', () => {
  test('git show --name-only output → absolute paths', () => {
    const out = 'added.ts\ngone.txt\nimg.bin\nkept.txt\nsp ace.txt\nsrc/new/move.ts\nuntracked.md\n'
    expect(parseNameOnly(out, ROOT)).toEqual([
      `${ROOT}/added.ts`,
      `${ROOT}/gone.txt`,
      `${ROOT}/img.bin`,
      `${ROOT}/kept.txt`,
      `${ROOT}/sp ace.txt`,
      `${ROOT}/src/new/move.ts`,
      `${ROOT}/untracked.md`,
    ])
  })

  test('diff-tree lists both sides of a rename; empty output → []', () => {
    expect(parseNameOnly('keep.txt\nkept.txt\n', '/r')).toEqual(['/r/keep.txt', '/r/kept.txt'])
    expect(parseNameOnly('', '/r')).toEqual([])
  })
})

describe('commitShaFromBash', () => {
  test('git commit stdout line', () => {
    expect(commitShaFromBash({}, '[main a1c9e42] fix: x\n 1 file changed, 1 insertion(+)')).toBe('a1c9e42')
  })

  test('root commit line', () => {
    const out = '[main (root-commit) 2341387] init: a\n 1 file changed, 1 insertion(+)\n create mode 100644 a\n'
    expect(commitShaFromBash(undefined, out)).toBe('2341387')
  })

  test('detached HEAD commit line', () => {
    expect(commitShaFromBash(null, '[detached HEAD 37262d5] feat: y\n')).toBe('37262d5')
  })

  test('a reported gitOperation sha wins over stdout', () => {
    const full = '0c0c1f34dee5bd07f1f4ae9cf5ee7113e2c8d8a4'
    expect(commitShaFromBash({ result: { gitOperation: { commit: { sha: full } } } }, '[main a1c9e42] x')).toBe(full)
    expect(commitShaFromBash({ result: { gitOperation: { sha: 'abcdef1' } } }, '')).toBe('abcdef1')
  })

  test('no commit → null; malformed sha is ignored', () => {
    expect(commitShaFromBash({}, 'On branch main\nnothing to commit, working tree clean\n')).toBe(null)
    expect(commitShaFromBash({ result: { gitOperation: { sha: 'nope' } } }, '')).toBe(null)
    expect(commitShaFromBash({}, '[main] not a sha\n')).toBe(null)
  })
})

describe('GIT_COMMANDS and shouldRefresh', () => {
  test('commands are the read-only argv lists', () => {
    expect(GIT_COMMANDS.status).toEqual(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    expect(GIT_COMMANDS.numstat).toEqual(['git', 'diff', '--numstat', 'HEAD'])
    expect(GIT_COMMANDS.aheadBehind).toEqual(['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'])
    expect([GIT_COMMANDS.root, GIT_COMMANDS.branch, GIT_COMMANDS.head]).toEqual([
      ['git', 'rev-parse', '--show-toplevel'],
      ['git', 'branch', '--show-current'],
      ['git', 'rev-parse', 'HEAD'],
    ])
  })

  test('throttles to one run per interval (default 2000 ms)', () => {
    expect(shouldRefresh(null, 5)).toBe(true)
    expect(shouldRefresh(1000, 2999)).toBe(false)
    expect(shouldRefresh(1000, 3000)).toBe(true)
    expect(shouldRefresh(1000, 1400, 500)).toBe(false)
    expect(shouldRefresh(1000, 1500, 500)).toBe(true)
  })
})

describe('upstream on the branch row', () => {
  test('the snapshot keeps the upstream name; none set (rev-parse failed) is null', () => {
    const base = { root: '/r\n', status: '', numstat: '', aheadBehind: '0\t1\n', branch: 'main\n', head: 'abc\n' }
    expect(snapshot({ ...base, upstream: 'origin/main\n' }).upstream).toBe('origin/main')
    expect(snapshot({ ...base, upstream: '' }).upstream).toBe(null)
    expect(snapshot(base).upstream).toBe(null)
  })
})
