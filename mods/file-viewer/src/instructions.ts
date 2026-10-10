// Instruction-file knowledge: which paths are instruction files, and parsers
// for the texts Claude Code hands mods (nested_memory, skill_listing, file
// restores, skill.prompt).
import type { InstructionOrigin, Owner } from './model.ts'
import { basename } from './paths.ts'

export type PathClass = { readonly origin: InstructionOrigin; readonly owner: Owner | null }

/** Classifies a path as an instruction file (CLAUDE.md, rules, memory, skill or plugin files) or null. */
export function classifyPath(path: string): PathClass | null {
  const plugin = /\/\.claude\/plugins\/(?:cache|marketplaces)\/[^/]+\/([^/]+)\//.exec(path)
  if (plugin) return { origin: 'plugin', owner: { kind: 'plugin', name: plugin[1]! } }
  const skill = /\/\.claude\/skills\/([^/]+)\//.exec(path)
  if (skill) return { origin: 'skill', owner: { kind: 'skill', name: skill[1]! } }
  if (/\/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(path)) return { origin: 'memory', owner: null }
  if (/\/\.claude\/rules\/.+\.md$/.test(path)) return { origin: 'project', owner: null }
  const name = basename(path)
  if (name === 'CLAUDE.local.md') return { origin: 'local', owner: null }
  if (name === 'CLAUDE.md' || name === 'AGENTS.md') return { origin: 'project', owner: null }
  return null
}

/** `nested_memory` text: `Contents of <abs path>:\n\n<content>`. */
export function parseNestedMemory(text: string): { path: string; content: string } | null {
  const m = /^Contents of (.+?):\n\n?([\s\S]*)$/.exec(text)
  return m ? { path: m[1]!, content: m[2]! } : null
}

export type SkillListing = { readonly name: string; readonly text: string }

/** `skill_listing` text: a header, then one `- name: description` entry per skill. */
export function parseSkillListing(text: string): { header: string; skills: SkillListing[] } {
  const skills: SkillListing[] = []
  const header: string[] = []
  let current: { name: string; lines: string[] } | null = null
  for (const line of text.split('\n')) {
    const m = /^- (\S+?): /.exec(line)
    if (m) {
      if (current) skills.push({ name: current.name, text: current.lines.join('\n') })
      current = { name: m[1]!, lines: [line] }
    } else if (current) current.lines.push(line)
    else header.push(line)
  }
  if (current) skills.push({ name: current.name, text: current.lines.join('\n') })
  return { header: header.join('\n'), skills }
}

/** Owner of a listed skill: `plugin:skill` names belong to the plugin. */
export function skillOwner(name: string): Owner {
  const i = name.indexOf(':')
  return i > 0 ? { kind: 'plugin', name: name.slice(0, i) } : { kind: 'skill', name }
}

/** `skill.prompt` text starts with `Base directory for this skill: <dir>`. */
export function skillBaseDir(text: string): string | null {
  const m = /^Base directory for this skill: (.+)$/m.exec(text)
  return m ? m[1]!.trim() : null
}

export type RestoredRead = { readonly path: string; readonly offset: number | null; readonly limit: number | null; readonly body: string }

/**
 * Post-compact `file` attachment: `Called the Read tool with the following
 * input: {json}\nResult of calling the Read tool:\n<numbered lines>`.
 */
export function parseRestoredRead(text: string): RestoredRead | null {
  const m = /^Called the Read tool with the following input: (\{.*\})\nResult of calling the Read tool:\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  try {
    const input = JSON.parse(m[1]!) as { file_path?: unknown; offset?: unknown; limit?: unknown }
    if (typeof input.file_path !== 'string') return null
    return {
      path: input.file_path,
      offset: typeof input.offset === 'number' ? input.offset : null,
      limit: typeof input.limit === 'number' ? input.limit : null,
      body: m[2]!,
    }
  } catch {
    return null
  }
}

/** First and last `N\t` line numbers in Read-style numbered text (non-empty lines only). */
export function numberedRange(body: string): readonly [number, number] | null {
  let first: number | null = null
  let last: number | null = null
  for (const line of body.split('\n')) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (first === null) first = n
    // A bare `N\t` with nothing after it is the phantom line after a final newline.
    if (m[2] !== '' || last === null) last = n
  }
  return first !== null && last !== null ? [first, last] : null
}

/** How many leading lines two texts share: the loaded part of a capped file. */
export function sharedLeadingLines(onDisk: string, loaded: string): number {
  const a = onDisk.split('\n')
  const b = loaded.split('\n')
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  // A trailing '' after the last newline isn't a line.
  if (n > 0 && n === a.length && a[n - 1] === '') n--
  return n
}

/** Normalized line count: a final newline does not start another line. */
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}
