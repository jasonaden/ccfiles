// The glyph set and the meta words: one table that the rows, the help view, the on-screen
// legend and the README all list. A glyph changed here must change in the README and docs/agents/REQUIREMENTS.md too
// (scripts/check-glyphs.ts compares them).
import type { ColorKey } from '../palette.ts'

export type GlyphSpec = {
  readonly glyph: string
  /** The help view's wording (the glyph table). */
  readonly meaning: string
  /** The on-screen legend's one-word form. */
  readonly short: string
  readonly color: ColorKey
}

export const GLYPHS = {
  full: { glyph: '●', meaning: 'read in full', short: 'read', color: 'read' },
  partial: { glyph: '◐', meaning: 'partly read (fill shows how much)', short: 'part', color: 'read' },
  match: { glyph: '◇', meaning: 'matched by a search (grep, rg or Grep), not read', short: 'match', color: 'search' },
  edited: { glyph: '✎', meaning: 'edited', short: 'edit', color: 'edit' },
  committed: { glyph: '◆', meaning: 'committed', short: 'commit', color: 'commit' },
  busy: { glyph: '◌', meaning: 'in progress (the name shimmers)', short: 'busy', color: 'pending' },
  auto: { glyph: '⚡', meaning: 'loaded by Claude Code itself, not by a tool call', short: 'auto', color: 'instruction' },
  seen: { glyph: '·', meaning: 'seen only (listed by ls, find, wc or Glob)', short: 'seen', color: 'muted' },
} as const satisfies Record<string, GlyphSpec>

/**
 * The coverage meter's partial steps: the gutter draws one of these for a partly read file, in its
 * state's colour (read, edited, committed, loaded). A Nerd Font draws 8 steps (circle slices); the help view says so.
 */
export const METER = {
  most: { glyph: '◕', meaning: 'read: most, not all (meter)', short: 'most', color: 'read' },
  half: { glyph: '◑', meaning: 'read: about half (meter)', short: 'half', color: 'read' },
  part: { glyph: '◔', meaning: 'read: under about a third (meter)', short: 'part', color: 'read' },
} as const satisfies Record<string, GlyphSpec>

/** The table in display order. */
export const GLYPH_TABLE: readonly GlyphSpec[] = [GLYPHS.full, METER.most, METER.half, METER.part, GLYPHS.match, GLYPHS.edited, GLYPHS.committed, GLYPHS.busy, GLYPHS.auto, GLYPHS.seen]

/** The inline activity tags. */
export const TAGS = { read: 'reading', edit: 'editing', commit: 'committing' } as const
export type TagKind = keyof typeof TAGS

/** The panel's keys as the help view lists them (README › Keys says the same). Help is `g`: `?` can't be a hotkey. */
export const HELP_KEY = 'g'
export const KEY_TABLE: readonly { readonly keys: string; readonly meaning: string }[] = [
  { keys: '1 2 3', meaning: 'Tree · Touched · Instructions' },
  { keys: 'j k', meaning: 'move down / up (arrows, PgUp/PgDn, wheel scroll)' },
  { keys: 'h l', meaning: 'collapse / expand a folder, group or fold' },
  { keys: 'd', meaning: 'detail of the selected file; d or q closes' },
  { keys: 's', meaning: 'search paths; c clears the filter' },
  { keys: HELP_KEY, meaning: 'help (this view)' },
  { keys: 'f', meaning: 'follow on / off' },
  { keys: 'y', meaning: 'copy the path' },
  { keys: 'o', meaning: 'sort Touched: recent, tokens, coverage' },
  { keys: 'a', meaning: 'viewpoint: main, then each subagent (once a subagent ran)' },
  { keys: 'u', meaning: 'per-agent ≈ tokens and exact usage (once a subagent ran; also at the end of this help)' },
]

/** Meta words and marks a row can show, as the help view explains them. */
export const META_WORDS: readonly { readonly text: string; readonly meaning: string }[] = [
  { text: '≈1.2k', meaning: 'right column, tokens form: estimated tokens (chars ÷ 4)' },
  { text: '74/210', meaning: 'lines read / total lines' },
  { text: '2/36', meaning: 'folder: files touched / total' },
  { text: '(≈1.2k)', meaning: 'read only by other agents, outside this view’s totals' },
  { text: '+N −N', meaning: 'git: lines added / removed' },
  { text: 'new', meaning: 'git: untracked or newly added' },
  { text: 'mod', meaning: 'git: modified, no line counts (binary)' },
  { text: 'del', meaning: 'git: deleted' },
  { text: 'ren', meaning: 'git: renamed' },
  { text: 'E G P C + m', meaning: 'subagent badge: Explore, general-purpose, Plan, custom, several kinds, main (from a subagent view)' },
  { text: '↩n', meaning: 're-read n times' },
  { text: '⟳', meaning: 'loaded again after /compact' },
  { text: '⊘', meaning: 'dropped by a compaction, not re-injected' },
  { text: '?', meaning: 'path unresolved or detected via fallback (never git state)' },
  { text: '▸ ▾', meaning: 'folder or group, collapsed / expanded' },
  { text: 'N files not read', meaning: 'untouched siblings folded into one row (l opens, h closes)' },
]
