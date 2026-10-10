// A small POSIX-ish shell splitter: enough to find which programs a Bash
// command runs and with which arguments. Not an interpreter: expansions stay
// literal, and anything it can't follow (heredocs, subshells) ends the parse.

/** One program run: its words (redirections removed) and its `<` input file. */
export type Stage = {
  readonly words: readonly string[]
  readonly stdin: string | null
  /** Its stdout goes to a file (`> out`, `>> log`, `&> all`), not to the command's output. */
  readonly toFile?: boolean
}

/** Stages joined by `|`. Commands are separated by `;`, `&&`, `||`, `&` or newlines. */
export type Pipeline = readonly Stage[]

type Token = { readonly op: string } | { readonly word: string; readonly quoted: boolean }

const OPERATORS = ['&&', '||', '>>', '&>', '2>', '>&', ';', '|', '&', '>', '<', '\n', '(', ')']

/** Splits a command line into pipelines; stops at the first construct it can't follow. */
export function splitCommand(command: string): Pipeline[] {
  const tokens = tokenize(command)
  const pipelines: Stage[][] = []
  let stages: Stage[] = []
  let words: string[] = []
  let stdin: string | null = null
  let toFile = false

  const endStage = () => {
    if (words.length > 0) stages.push(toFile ? { words, stdin, toFile } : { words, stdin })
    words = []
    stdin = null
    toFile = false
  }
  const endPipeline = () => {
    endStage()
    if (stages.length > 0) pipelines.push(stages)
    stages = []
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if ('word' in t) {
      words.push(t.word)
      continue
    }
    switch (t.op) {
      case '|':
        endStage()
        break
      case ';':
      case '&&':
      case '||':
      case '&':
      case '\n':
        endPipeline()
        break
      case '<': {
        const next = tokens[i + 1]
        if (next && 'word' in next) {
          stdin = next.word
          i++
        }
        break
      }
      case '>':
      case '>>':
      case '&>':
      case '2>':
      case '>&': {
        // Skip the target (a file, or `&1` style descriptors already eaten by the tokenizer).
        const next = tokens[i + 1]
        if (next && 'word' in next) {
          // `2>` is stderr; `>&2` and `2>&1` move descriptors; `> file`, `>> file`, `&> file` take stdout away.
          if ((t.op === '>' || t.op === '>>' || t.op === '&>') && !/^&?\d$/.test(next.word) && next.word !== '/dev/stdout') toFile = true
          i++
        }
        break
      }
      case '<<':
      case '(':
      case ')':
      default:
        endPipeline()
        return pipelines
    }
  }
  endPipeline()
  return pipelines
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let cur = ''
  let inWord = false
  let quoted = false

  const flush = () => {
    if (inWord) out.push({ word: cur, quoted })
    cur = ''
    inWord = false
    quoted = false
  }

  while (i < src.length) {
    const c = src[i]!
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return [...out, { op: 'unterminated' }]
      cur += src.slice(i + 1, end)
      inWord = true
      quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1]!)) j++
        s += src[j]
        j++
      }
      if (j >= src.length) return [...out, { op: 'unterminated' }]
      cur += s
      inWord = true
      quoted = true
      i = j + 1
      continue
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      cur += src[i + 1] ?? ''
      inWord = true
      i += 2
      continue
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (src.startsWith('<<', i)) {
      flush()
      out.push({ op: '<<' })
      return out
    }
    // A descriptor redirect like 2>&1 or >&2 is one unit with no file target.
    const dup = /^[0-9]?>&[0-9-]/.exec(src.slice(i))
    if (dup && !inWord) {
      i += dup[0].length
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op && !(op === '2>' && inWord)) {
      flush()
      out.push({ op })
      i += op.length
      continue
    }
    cur += c
    inWord = true
    i++
  }
  flush()
  return out
}
