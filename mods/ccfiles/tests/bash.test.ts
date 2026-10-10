import { describe, expect, test } from 'claude-code/testing'
import { bashActions, parseCommand, pathsNeedingTotals } from '../src/bash.ts'

const CWD = '/tmp/fv'
const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `big.md line ${i + from}: lorem`).join('\n')
const run = (command: string, stdout = '', totals: Record<string, number> = {}, text?: string) =>
  bashActions(command, { cwd: CWD, stdout, text: text ?? stdout, totals: (p) => totals[p] ?? null })

describe('Bash reads with known ranges', () => {
  test("sed -n '10,20p' adds lines 10–20", () => {
    expect(run("sed -n '10,20p' /tmp/fv/big.md", lines(11, 10))).toEqual([
      expect.objectContaining({ kind: 'read', tool: 'Bash:sed', path: '/tmp/fv/big.md', ranges: [[10, 20]], unknown: false }),
    ])
  })

  test('head -n 50 adds lines 1–50', () => {
    expect(run('head -n 50 big.md', lines(50))).toEqual([
      expect.objectContaining({ kind: 'read', tool: 'Bash:head', path: '/tmp/fv/big.md', ranges: [[1, 50]] }),
    ])
  })

  test('head stops at the end of a short file: only the lines shown count', () => {
    expect(run('head -n 50 small.ts', lines(40))[0]).toMatchObject({ ranges: [[1, 40]], totalLines: 40 })
  })

  test("sed '/a/,/b/p' is a read with unknown ranges (partial-unknown)", () => {
    expect(run("sed '/a/,/b/p' big.md", 'x')).toEqual([
      expect.objectContaining({ kind: 'read', path: '/tmp/fv/big.md', ranges: [], unknown: true }),
    ])
  })

  test('a read piped into another command is partial-unknown', () => {
    expect(run("sed -n '/line 5:/,/line 9:/p' big.md | wc -l", '5')).toEqual([
      expect.objectContaining({ kind: 'read', path: '/tmp/fv/big.md', unknown: true }),
    ])
  })

  test('a known-range read becomes unknown once piped through a filter', () => {
    expect(run('head -n 50 big.md | grep lorem', lines(50))[0]).toMatchObject({ ranges: [], unknown: true })
    expect(run('cat small.ts | sort', lines(40))[0]).toMatchObject({ unknown: true })
  })

  test('head -5, -n5 and --lines=5 are the same read', () => {
    for (const cmd of ['head -5 big.md', 'head -n5 big.md', 'head --lines=5 big.md']) {
      expect(run(cmd, lines(5))[0]).toMatchObject({ ranges: [[1, 5]] })
    }
  })

  test('tail -n 20 uses the known total', () => {
    expect(run('tail -n 20 big.md', lines(20, 1304), { '/tmp/fv/big.md': 1323 })[0]).toMatchObject({ ranges: [[1304, 1323]] })
  })

  test('tail +K reads from line K to the end', () => {
    expect(run('tail -n +1300 big.md', lines(24, 1300), { '/tmp/fv/big.md': 1323 })[0]).toMatchObject({ ranges: [[1300, 1323]] })
  })

  test('tail without a known total is partial-unknown', () => {
    expect(run('tail big.md', lines(10))[0]).toMatchObject({ unknown: true })
  })

  test('cat and nl read the whole file', () => {
    const [cat] = run('cat small.ts', lines(40))
    expect(cat).toMatchObject({ tool: 'Bash:cat', ranges: [[1, 40]], totalLines: 40, unknown: false })
    expect(run('nl -ba small.ts', lines(40))[0]).toMatchObject({ tool: 'Bash:nl', ranges: [[1, 40]] })
  })

  test('cat of several files reads each whole when totals are known', () => {
    const out = run('cat a.ts b.ts', 'x\ny\nz', { '/tmp/fv/a.ts': 2, '/tmp/fv/b.ts': 1 })
    expect(out.map((a) => [a.path, a.ranges])).toEqual([['/tmp/fv/a.ts', [[1, 2]]], ['/tmp/fv/b.ts', [[1, 1]]]])
  })

  test('sed -n with several ranges and A,$', () => {
    expect(run("sed -n '1,5p;10,12p' big.md", lines(8))[0]).toMatchObject({ ranges: [[1, 5], [10, 12]] })
    expect(run("sed -n '1300,$p' big.md", lines(24, 1300), { '/tmp/fv/big.md': 1323 })[0]).toMatchObject({ ranges: [[1300, 1323]] })
  })

  test('sed 5q is head -5; sed -i is not a read', () => {
    expect(run('sed 5q big.md', lines(5))[0]).toMatchObject({ ranges: [[1, 5]] })
    expect(run("sed -i 's/a/b/' big.md")).toEqual([])
  })

  test('cd before the read changes where relative paths resolve', () => {
    expect(run('cd sub && cat a.ts', lines(20))[0]).toMatchObject({ path: '/tmp/fv/sub/a.ts' })
  })

  test('quoted paths with spaces and ./ prefixes resolve', () => {
    expect(run('cat "my notes.md"', 'x')[0]).toMatchObject({ path: '/tmp/fv/my notes.md' })
    expect(run('cat ./docs/../small.ts', 'x')[0]).toMatchObject({ path: '/tmp/fv/small.ts' })
  })

  test('the estimate counts the text Claude received, split across the files read', () => {
    const text = 'x'.repeat(400)
    const out = run('cat a.ts b.ts', text, { '/tmp/fv/a.ts': 1, '/tmp/fv/b.ts': 1 })
    expect(out.map((a) => a.estTokens)).toEqual([50, 50])
  })
})

describe('Bash output cut to a preview', () => {
  test('only the complete lines shown in the preview count, and the read is marked unverified', () => {
    const preview = [
      '<persisted-output>',
      'Output too large (96KB). Full output saved to: /tmp/x/tool-results/abc.txt',
      '',
      'Preview (first 2KB):',
      lines(27),
      'big.md line 28: lor',
      '...',
      '</persisted-output>',
    ].join('\n')
    const [read] = run('cat big.md', lines(1323), { '/tmp/fv/big.md': 1323 }, preview)
    expect(read).toMatchObject({ ranges: [[1, 27]], unknown: false, verified: false })
  })
})

describe('search hits and listings', () => {
  test('grep -rn marks each file in its output as a hit, with no ranges', () => {
    const stdout =
      '.claude/skills/demo/reference.md:77:reference.md line 77: demo skill reference material.\n' +
      'big.md:77:big.md line 77: lorem ipsum dolor sit amet, consectetur adipiscing elit.'
    expect(run("grep -rn 'line 77:' .", stdout)).toEqual([
      expect.objectContaining({ kind: 'hit', tool: 'Bash:grep', path: '/tmp/fv/.claude/skills/demo/reference.md', ranges: [] }),
      expect.objectContaining({ kind: 'hit', tool: 'Bash:grep', path: '/tmp/fv/big.md', ranges: [] }),
    ])
  })

  test('grep on one file hits that file when anything matched', () => {
    expect(run('grep -n foo small.ts', '3:foo')).toEqual([expect.objectContaining({ kind: 'hit', path: '/tmp/fv/small.ts' })])
    expect(run('grep -n foo small.ts', '')).toEqual([])
  })

  test('grep -l and rg list matching paths', () => {
    expect(run('grep -rl foo src', 'src/a.ts\nsrc/b.ts').map((a) => a.path)).toEqual(['/tmp/fv/src/a.ts', '/tmp/fv/src/b.ts'])
    expect(run('rg -n foo', 'src/a.ts:3:foo\nsrc/a.ts:9:foo').map((a) => [a.kind, a.tool, a.path])).toEqual([
      ['hit', 'Bash:rg', '/tmp/fv/src/a.ts'],
    ])
  })

  test('grep piped to head still yields the hits shown', () => {
    expect(run('grep -rn foo . | head -1', './a.ts:1:foo').map((a) => a.path)).toEqual(['/tmp/fv/a.ts'])
  })

  test('find lists each path it printed; ls lists its directory', () => {
    expect(run("find . -name '*.ts'", './small.ts\n./sub/a.ts').map((a) => [a.kind, a.path])).toEqual([
      ['listing', '/tmp/fv/small.ts'],
      ['listing', '/tmp/fv/sub/a.ts'],
    ])
    expect(run('ls -la docs', 'style.md').map((a) => [a.kind, a.path])).toEqual([['listing', '/tmp/fv/docs']])
    expect(run('ls', 'a').map((a) => a.path)).toEqual(['/tmp/fv'])
  })

  test('wc -l is a listing that reports the file length', () => {
    expect(run('wc -l big.md', '1323 big.md')).toEqual([
      expect.objectContaining({ kind: 'listing', tool: 'Bash:wc', path: '/tmp/fv/big.md', totalLines: 1323 }),
    ])
  })

  test('hits, listings and git commands add no coverage', () => {
    for (const a of [...run('grep -rn x .', 'a.ts:1:x'), ...run('find .', './a'), ...run('git status', ' M a.ts')]) {
      expect(a.ranges).toEqual([])
      expect(a.estTokens).toBe(0)
    }
  })
})

describe('commands that read nothing', () => {
  test('writes, echoes and unknown programs produce no actions', () => {
    for (const cmd of ['echo hi > out.txt', 'npm test', 'mkdir -p x', 'python3 script.py']) expect(run(cmd, 'ok')).toEqual([])
  })

  test('git verbs are classified', () => {
    expect(parseCommand('git -C repo commit -m "fix: x"', CWD).git).toEqual(['commit'])
    expect(parseCommand('git add -A && git commit -qm msg && git push', CWD).git).toEqual(['add', 'commit', 'push'])
  })

  test('a variable, substitution or glob is never recorded as a file name', () => {
    for (const cmd of ['for f in a.ts b.ts; do cat "$f"; done', 'cat $(git ls-files)', 'head -5 `ls *.md`', 'cat src/*.ts', 'ls $DIR'])
      expect(run(cmd, 'some output').filter((a) => /[$`*]/.test(a.path))).toEqual([])
  })

  test('heredocs and unbalanced quotes do not throw', () => {
    expect(run("cat <<'EOF' > f.md\nhello\nEOF", '')).toEqual([])
    expect(() => run("cat 'unterminated", '')).not.toThrow()
  })
})

describe('totals the hook must look up before resolving', () => {
  test('tail, A,$ and multi-file whole reads need totals; head and bounded sed do not', () => {
    expect(pathsNeedingTotals(parseCommand('tail -n 5 big.md', CWD))).toEqual(['/tmp/fv/big.md'])
    expect(pathsNeedingTotals(parseCommand("sed -n '5,$p' big.md", CWD))).toEqual(['/tmp/fv/big.md'])
    expect(pathsNeedingTotals(parseCommand('cat a.ts b.ts', CWD))).toEqual(['/tmp/fv/a.ts', '/tmp/fv/b.ts'])
    expect(pathsNeedingTotals(parseCommand('head -n 5 big.md', CWD))).toEqual([])
    expect(pathsNeedingTotals(parseCommand("sed -n '1,5p' big.md", CWD))).toEqual([])
  })
})

describe('cd inside a command', () => {
  test('grep and find output after cd X resolves under X', () => {
    expect(run("cd sub && grep -rn 'a2' .", './a.ts:2:export const a2 = 2;').map((a) => a.path)).toEqual(['/tmp/fv/sub/a.ts'])
    expect(run('cd sub; find . -name "*.ts"', './a.ts').map((a) => a.path)).toEqual(['/tmp/fv/sub/a.ts'])
  })

  test('cwdAfter: the last cd wins; home for cd and cd ~; null for cd -', () => {
    expect(parseCommand('cd sub && ls', CWD).cwdAfter).toBe('/tmp/fv/sub')
    expect(parseCommand('cd sub; cd ..', CWD).cwdAfter).toBe('/tmp/fv')
    expect(parseCommand('cd', CWD, '/home/u').cwdAfter).toBe('/home/u')
    expect(parseCommand('cd ~/x', CWD, '/home/u').cwdAfter).toBe('/home/u/x')
    expect(parseCommand('cd -', CWD, '/home/u').cwdAfter).toBe(null)
    expect(parseCommand('ls', CWD).cwdAfter).toBe(undefined)
    // A subshell's cd doesn't outlive it (the parser stops at the subshell).
    expect(parseCommand('(cd sub && ls)', CWD).cwdAfter).toBe(undefined)
  })
})
