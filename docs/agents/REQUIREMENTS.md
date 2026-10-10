# File Viewer: requirements

The File Viewer is a Claude Code mod (`mods/file-viewer`, plugin name `file-viewer`). It adds a docked side
panel that shows which files Claude read, searched, edited and committed, how much of each file it saw, which
instruction files are in its context, and an **estimated** token cost per file next to exact API usage.

This document describes the product as built. Requirement IDs (`CORE-1`, `ROW-3`, …) are stable; cite them in
code and reviews. Platform facts the code relies on are in `PLATFORM.md`.

Terms used below:

- **Session root:** the project folder Claude Code runs in (`$.session.root()`).
- **Touched:** read, searched, edited, written, committed, loaded by Claude Code, changed in git, or in flight.
  A listing alone (`ls`, `find`, Glob) is not touched; neither is an untracked file nobody read.
- **Epoch:** the span between two compactions. Compactions are counted from the session start.
- **Viewpoint:** whose view the lists show: main (the default) or one subagent.
- **≈ figure:** a token estimate, characters ÷ 4. **Exact figure:** API usage from `turn.step`.

## Core constraints

- **CORE-1 Observe only.** Every hook on Claude Code's events returns `next(e)` or the untouched result of
  `await next(e)`. It never denies, never rewrites tool args, results or prompts, and never answers in Claude
  Code's place. Exceptions:
  - the opt-in selection line on `prompt.submit` (SET table, `selectionContext`);
  - the `classic.SessionStart` result gains two `watchPaths` (`<cwd>/.git/index`, `<cwd>/.git/HEAD`). This adds
    file watches only; nothing Claude receives changes.
  The panel's own hooks (`command.run` for `/files`, and `ui.render`, `ui.scroll`, `ui.message` for its own pane
  id) answer only for this mod's pane and pass everything else on.
- **CORE-2 No network.** The mod never calls `$.http`, `$.model` or `$.mcp`, and uses no token-counting API.
  `scripts/check.sh` fails if `claude plugin validate`'s `calls:` line lists any of them. Local processes are
  limited to read-only `git` commands and one `fc-list` run.
- **CORE-3 Fast hooks.** A hook calls `next(e)` before any parsing, file reads, git runs or state work, except
  `tool.call`'s pending bookkeeping and `turn.step`'s step marker, which are synchronous. Every hook body is
  wrapped so an ingestion error never reaches Claude Code, and every hook on Claude Code's own events has a
  `.catch` that calls `next(e)`.
- **CORE-4 Tokens are estimates.** Every per-file and per-read token figure is characters ÷ 4 of the text
  Claude received and is drawn with `≈` (TOK section). Only `turn.step` usage figures are exact; they are labelled
  `exact`, or `=` beside a legend. `=` never marks an estimate.
- **CORE-5 State is never colour-only.** Every state has a glyph, mark or word: the gutter glyph or meter, the
  marks `✎ ◆ ⚡ ↩n ⟳ ⊘ ?`, git meta words, letter badges for subagents, strikethrough for deleted files.
- **CORE-6 Configurable palette.** Colours come from a user file and a `palette` setting (PAL section).
- **CORE-7 Animation only while lit.** No timer runs while the panel is idle. The rows Client animates only while
  a row shimmers; the hooks side sets one one-shot timer for the next fade.

## Opening the panel

- **PANEL-1** `/files` (registered at `session.start`, immediate) opens a docked pane with id `file-viewer` and
  title `Files`, with focus. The panel never opens on its own.
- **PANEL-2** Outside the fullscreen layout `/files` refuses with: "File Viewer needs the fullscreen layout to
  dock beside the transcript. Run /tui fullscreen, then /files." Under 110 terminal columns it refuses with the
  width and "Widen it to ≥110 columns, then run /files."
- **PANEL-3** When placed it answers `File Viewer open: 1 Tree · 2 Touched · 3 Instructions (keys: …)`; when not
  placed, `File Viewer: not placed (<reason>)`.
- **PANEL-4** Recording runs whether or not the panel is open. Redraws, the project walk and outside-repo git runs
  happen only while it is open.

## Layout

From top to bottom: header row, branch row, tab strip, agents line, list, footer.

- **LAYOUT-1 Header row.** Left: the breadcrumb, bold in `accent`: the session root's name, or the focused path
  (`project ▸ packages ▸ retrieval`, ROOT section). It fits the width minus 22 cells by turning middle segments
  into `…`, keeping the last. Right: seven one-glyph buttons with a hover background, never `x: label` text:

  | Button | Does |
  |---|---|
  | `?` | open or close the help view (dim unless help is open); click only, the key is `g` |
  | `↑` | focus the parent folder, above the session root too |
  | `⌂` | back to the session root (dim when not focused) |
  | `↻` | refresh git now (GIT-2 throttle applies) |
  | `◉` | follow on/off: bright while following, dim while paused |
  | `Σ` | cycle the right column: tokens → lines → date → size |
  | `⊟` / `⊞` | collapse every folder / back to the default view (TREE-8) |

- **LAYOUT-2 Branch row**, only when the shown repo is a git repo (GIT-6 picks the repo). Left:
  `⎇  main ↑4 ↓1 origin/main` (ahead in `search`, behind in `git.M`, upstream muted; `detached` with no branch).
  Right: `+223 −21 · 4 new · 6 mod · 1 del · 2 ren`, or `clean`. Narrow: the upstream drops first, then the
  per-state counts, then `+N −N`; the branch and ahead/behind stay.
- **LAYOUT-3 Tab strip.** `Tree`, `Touched N`, `Instructions N`, each padded one cell each side, then the search
  field at the right end. The active tab has the `selection` background, bold underlined `accent` label; inactive
  tabs use `text`. Touched counts files with an action, an instruction load or another agent's share; Instructions
  counts instruction files. Both exclude skill-description rows and follow the viewpoint. Narrow: the search
  placeholder shrinks to `/`, then `Instructions` becomes `Instr`.
- **LAYOUT-4 Agents line**, once a subagent exists (AGENT section).
- **LAYOUT-5 List.** Tree is the default tab. A list longer than its area gives its last line to one fixed note,
  `⋮ N more`, plus `· M active` when lit or in-flight rows are out of view, so the list never jumps. Empty
  states: `no paths match "<query>"`, `no files found under <dir>` (Tree), `nothing yet: files show here as Claude
  touches them`.
- **LAYOUT-6 Footer**, one line. Left: `context 58k` (bold `accent`) ` exact` · `files ≈12k`. Right: the activity
  chip: `◌ [<agent> ]reading|editing|committing <path>` while a call runs (newest), else `✓ committed <sha7>`
  for the session's latest commit. `context` is input + cache read + cache creation of the latest main request,
  absent until the first request. `files` is the ≈ tokens of files in the main context now (TOK-7). In a subagent
  viewpoint `context` is that agent's latest request and `files` is ≈0 (subagent context is not tracked per
  file). Narrow: the chip shortens (`◌ a.ts`, `✓ a1c9e42`), then `files` drops, then the chip; `context` never
  drops.

## Rows

- **ROW-1 One line, exact width.** Every row is one terminal line exactly the pane width, at every width and
  during activity. Long names end in `…`.
- **ROW-2 Anatomy.** Left to right: state cell, space, badge cell, space, 3 cells per depth level, caret slot
  (`▸`/`▾` and a space; blank on files), icon slot (icon and two spaces), name, marks, then a git column and a
  value column. The git and value columns have one width across the visible window and are right-aligned, with
  2 cells between name, git and value. A two-cell state glyph takes the state cell and its space.
- **ROW-3 Narrow rows.** Below 52 panel columns, parts drop while the deepest visible name would get fewer than
  12 cells: first the icon, then git meta shortened to its first figure, then git meta entirely. Marks are kept.
- **ROW-4 Gutter cell 0** shows the viewpoint's state for a file: the coverage meter for a read file (COV-6),
  else `◆` or `✎`, else `◇` for a search hit, else `·` for a listing, `◌` while a call on it is in flight, blank
  when untouched. A collapsed folder shows the glyph of the latest lit activity inside it (`◌` when a call inside
  is in flight).
- **ROW-5 Gutter cell 1** shows the subagent badge (AGENT-4).
- **ROW-6 Name colour.** In flight: `pending`. Lit (ACT-2): the state colour, bold. Out of context since a
  compaction: `muted`. Else git state: modified `git.M`, added or untracked `git.A`, deleted `git.D` with
  strikethrough, renamed `git.R`, ignored `git.ignored`. A touched clean file uses `text`, an untouched one
  `muted`. Folders use `git.A` when every change under them is new, `git.M` for other changes, `text` when
  something inside is touched, else `muted`. Section and group headers are bold. Folder names have no trailing `/`.
- **ROW-7 Marks** after the name: `↩n` re-read n times, `⟳` loaded again after a compaction, `⊘` dropped by a
  compaction, `◆`/`✎` when not already the gutter glyph (also `✎` for another agent's edit), `?` unresolved or
  unverified detection, `⚡` for an instruction file loaded without a tool read (Claude Code loads, and a SKILL.md
  loaded through the Skill tool); the Instructions tab draws no `⚡` marks.
- **ROW-8 Git column.** Files: `+N −N`, then `new` (untracked or added), `del`, `ren`, or `mod` (modified with no
  line counts). Ignored files show nothing. A collapsed folder sums its changes: `+N −N`, else `N new`, else
  `N mod`.
- **ROW-9 Value column**, cycled by `Σ` in every tab:

  | Form | File | Folder |
  |---|---|---|
  | tokens (default) | `≈1.2k`; `(≈1.2k)` when only other agents read it | ≈ rollup when collapsed, or when more than one file inside carries tokens |
  | lines | `74/210` lines read / total; `desc` for a skill description | `2/36` files touched / total |
  | date | modified: `14:02` today, `Oct 9` this year, `Oct 9 2025` before | the newest file's time under it |
  | size | `812B`, `12K`, `1.4M`, `2.1G` | blank |

  Date and size come from the session-root walk; files outside it show none.
- **ROW-10 Out of context.** A file the main context held and a compaction dropped (with nothing re-injecting it)
  is drawn dimmed: glyph, name, marks and git meta in `muted`, `⊘` kept.
- **ROW-11 Selection** draws the `selection` background and underlines the name. Hover on a pressable row draws
  a 60% mix of the background and `selection`.
- **ROW-12 Readable text.** Each drawn foreground must reach 4.5:1 against what it sits on (3:1 for `muted` and
  `git.ignored` off the selection), as given and, below truecolor, as the 256-colour cells drawn. A colour that
  fails is replaced by `text`, else black or white. Theme-key colours are not checked.

## Glyphs

The gutter shows Claude's state for each file. For a read file it is a coverage meter in the state's colour;
with a Nerd Font the meter has 8 steps.

| Glyph | Meaning |
|---|---|
| `●` | read in full |
| `◕` | read: most, not all (meter) |
| `◑` | read: about half (meter) |
| `◔` | read: under about a third (meter) |
| `◇` | matched by a search (grep, rg or Grep), not read |
| `✎` | edited |
| `◆` | committed |
| `◌` | in progress (the name shimmers) |
| `⚡` | loaded by Claude Code itself, not by a tool call |
| `·` | seen only (listed by ls, find, wc or Glob) |

- **GLYPH-1** `src/view/glyphs.ts` (`GLYPH_TABLE`) is the source of this set. The help view, the README table and
  this table list the same glyphs; `scripts/check-glyphs.ts` fails the build otherwise.
- **GLYPH-2** Row meta words and marks, as the help view explains them:

  | Text | Meaning |
  |---|---|
  | `≈1.2k` | estimated tokens (chars ÷ 4) |
  | `74/210` | lines read / total lines |
  | `2/36` | folder: files touched / total |
  | `(≈1.2k)` | read only by other agents, outside this view's totals |
  | `+N −N` | git: lines added / removed |
  | `new` `mod` `del` `ren` | git: untracked or added / modified with no counts / deleted / renamed |
  | `E G P C + m` | subagent badge: Explore, general-purpose, Plan, custom, several kinds, main |
  | `↩n` `⟳` `⊘` | re-read n times / loaded again after /compact / dropped by a compaction |
  | `?` | path unresolved or detected via fallback (never git state) |
  | `▸ ▾` | folder or group, collapsed / expanded |
  | `N files not read` | untouched siblings folded into one row |

## Activity

- **ACT-1 Pending.** When `tool.call` fires for Read, Edit, Write, NotebookEdit, or a Bash command whose first
  parsed action reads a file, that file's row shows `◌`, the `pending` name colour and a shimmer, before the call
  returns. A Bash `git commit` in flight marks the files it commits: the staged files, or with `-a`/`--all` every
  tracked change.
- **ACT-2 Settled.** After a successful read, edit, write, commit or Claude Code load, the row is lit for 2.7 s:
  the name in the state colour (`read`, `edit`, `commit`, `instruction`), bold, then back to its git colour.
  Search hits and listings never light. Denied and errored calls never light.
- **ACT-3 Shimmer.** While a read, edit or commit is in flight, a 4-step band in the state colour sweeps across
  the name's characters only (about one sweep per second, 90 ms ticks). Rows shimmer out of step with each other.
  The shimmer lasts at least 600 ms from the call's start.
- **ACT-4 Reduced motion.** With `motion: off` there is no band: the name holds its state colour, bold, for the
  same times.
- **ACT-5 Follow.** On by default. When Claude touches a file inside the session root, its folders open; at most
  20 hits or listings per call are revealed. The list keeps the in-flight row (else the most recently lit row) in
  view, centred. A person's scroll, drag, `j`/`k` move or search jump pauses follow; `f` or `◉` toggles it.

## Tree tab

- **TREE-1** The Tree lists the session root's files from a breadth-first walk that skips `.git`, `node_modules`,
  `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `target`, `.venv`, `venv`,
  `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.gradle`, `.idea` and `vendor`. It stops at 20,000 files, spends
  at most 150 ms per render and finishes in the background. Touched and git-changed paths inside the root are
  added even when the walk did not find them. The walk reruns, at most every 3 s, after a Bash call, a Write or a
  Bash write.
- **TREE-2** Folders sort before files, each by name. Folders are collapsed until opened.
- **TREE-3 Folding.** Inside a folder that holds anything touched, only touched files and folders holding touched
  files get rows. The untouched rest fold into one row at the end, e.g. `16 files, 2 folders not read` (singular
  for one, zero parts left out), collapsed until opened. A folder with nothing touched inside, opened by hand,
  lists its children directly.
- **TREE-4 Sections.** After the session root's rows come, in order: the **Loaded by Claude Code** section
  (TREE-6), then one section per outside root (ROOT section). Sections are hidden while focused elsewhere or while
  a search is active.
- **TREE-5 Claude Code loads in place.** CLAUDE.md, AGENTS.md, rules, nested CLAUDE.md files and auto memory that
  Claude Code loaded by itself sit at their place in the Tree with the system icon, a meter in the `instruction`
  colour and the `⚡` mark (the mark is left out when the plain-glyph icon is already `⚡`).
- **TREE-6 Loaded by Claude Code section.** Loads outside the session root and every outside root
  (`~/.claude/CLAUDE.md`, a parent folder's CLAUDE.md, auto memory) are listed, by path, under a section header
  with the system icon, the file count and the ≈ total. It is collapsed until opened.
- **TREE-7 `claudeCodeLoads: hide`** removes the Loaded by Claude Code section and folds a file only Claude Code
  loaded as untouched (unless git changed it). Such a file, when drawn (inside an opened fold), keeps its system
  icon and `⚡`. The Touched and Instructions tabs do not change.
- **TREE-8 Collapse toggle.** `⊟` closes every folder and fold (section headers, Instructions groups and Touched
  groups keep their state) and the button becomes `⊞`. `⊞` returns to the default view: the folders above touched
  and git-changed files open, untouched siblings folded. Opening a folder by hand clears the toggle. Follow's
  reveal does not clear it.

## Touched tab

- **TOUCH-1** Lists every touched file and every file with a call in flight, plus files only other agents saw
  (once a subagent ran). Skill-description rows are excluded. Labels are paths relative to the session root,
  `~/…` under home, `MEMORY.md (auto memory)`, or `<path> (directory unknown)` for an unresolved Bash path.
- **TOUCH-2** Sort, cycled by `o`: recent (default), ≈ tokens (largest first), coverage (least first). Ties sort
  by recency. In-flight files with no record yet come first.
- **TOUCH-3** Files under an outside root are grouped under a section header with the same label as the Tree, after
  the project's files, each group sorted the same way. Group rows show paths relative to the section root. A group
  is open by default; a press closes it. Loads outside every root stay in the top group.

## Instructions tab

- **INSTR-1** A summary line in `instruction`: `N auto · M skills · ≈X tok of ≈Y read`, plus `· ≈Z tok in
  context` when the in-context share differs from the cumulative one.
- **INSTR-2 Groups**, each header with a count and ≈ total:
  - `⚡ Auto-loaded`: files Claude Code loaded by itself. `⚡` appears once, on this header; its rows do not
    repeat it.
  - `Skills`: one sub-header per skill with its description row, SKILL.md and supporting files. Skills known only
    by their description fold into one `other skills` row (`N descriptions`), except a skill whose SKILL.md lies
    inside the project. Skills never carry `⚡`.
  - `Plugins and other`: one folded row per plugin (`N files`, opens on press or `l`), then instruction files
    read only through a tool.
- **INSTR-3** Rows draw through the same anatomy as Tree rows; the gutter shows the meter of the share loaded or
  read.

## Detail, help and agents views

- **VIEW-1 Detail** (`d`, Enter, or a press on a file row) replaces the list and shows: the display path and the
  absolute path; `lines` ranges / total · % · `R/T lines read` · coverage state; a 10-cell eighth-block mini bar;
  read and authored ranges when Claude wrote lines; `tokens` (≈, reads, re-reads, already-in-context stubs, search
  hits); `context` (`⊘ out of context since compaction`, or ≈ in context now when it differs); `written ≈N (not
  cost) · +N −N`; git letter and counts (`(staged)`); for instruction files the mode (auto-loaded, read via tool,
  both), origin, load count and reasons, trigger, parent, globs, `capped`, lines received after front matter
  stripping, resolved path; owner; `⟳ N× after /compact`; the fallback or unverified note; denied and errored
  counts; `via` agents; a `by agent` table (ranges, coverage, reads, ≈) once a subagent took part; the history,
  newest first (time, tool or source, reason, range, outcome, ≈, agent); the session's exact usage (latest
  context, billed ∑ incl. cache re-reads, output); the legend `≈ estimated (chars ÷ 4) · = exact (API usage)`;
  the theme hint (PAL-4); then the help lines.
- **VIEW-2 Closing.** `d` or `q` closes the detail and gives the keyboard back to the prompt by closing the pane
  and opening it again without focus. Tab, selection, scroll and folds are kept.
- **VIEW-3 Help** (`g` or the `?` button) lists every key and whether it needs a click, the header buttons, the
  glyph table, the meta words, the gutter, icon and `Σ` columns, where colours come from, `billed ∑ =N exact,
  incl. cache re-reads (never the context size) · out =N`, and once a subagent ran, the agents table. `g` or `?`
  again, `d`, `q` or a tab closes it.
- **VIEW-4 Agents** (`u`, once a subagent ran): one row per agent (main first) with files, ≈ read, `=` billed,
  `=` out, status (`running`, `done in Ns`), `from <parent>` and its task description; an `other` row for Claude
  Code's own forks; a total row equal to the session totals; the legend; the attribution path.
- **VIEW-5** These views scroll with `j`/`k`/the wheel, and `y` copies the detail's path.

## Keys and mouse

- **KEY-1** Every key in the table works with no click once the pane has the keyboard (`ctrl+x tab`), through
  hidden hotkeys. After a click in the list, the rows Client receives keys directly, including arrows, PgUp/PgDn
  and Enter.

  | Key | Does |
  |---|---|
  | `1` `2` `3` | Tree · Touched · Instructions (closes any detail or help) |
  | `j` `k` | move down / up (arrows after a click; PgUp/PgDn move a page) |
  | `h` `l` | collapse / expand a folder, fold, group or section; `h` on a leaf selects its parent; `l` on a file opens its detail |
  | `d` | detail of the selected file; `d` or `q` closes it |
  | Enter | after a click: focus a folder or section; elsewhere like a press |
  | `s` | focus the search field |
  | `c` | clear the search filter |
  | `g` | help |
  | `f` | follow on / off |
  | `y` | copy the selected file's absolute path |
  | `o` | sort the Touched tab |
  | `a` | viewpoint: main, then each subagent, then main (once a subagent ran) |
  | `u` | agents view (once a subagent ran) |

- **KEY-2 Scroll.** The wheel, arrows, PgUp/PgDn and Home/End on the focused pane scroll the list; a person's
  scroll pauses follow. The list never scrolls past its end.
- **KEY-3 Mouse on the list.** A press on a row selects it and activates it: folders, folds, groups and sections
  toggle; a file opens its detail. A second press on the same folder or section within 450 ms focuses it.
  Right-click copies the row's path. Dragging scrolls the list one row per cell and pauses follow.
- **KEY-4 Keyboard ownership.** After any press of the panel's own controls the focus ring moves to a visible
  control (the `?` button) so the next key still reaches the pane. Opening the detail by click hands the keyboard to
  the same button.
- **KEY-5 Search.** Typing in the search field filters every tab by a case-insensitive substring of the relative
  path. In Tree every match shows with its folders open. Enter reveals every hit, selects the first, pauses
  follow, empties the field (the placeholder shows `/ "<query>"`) and gives the keys back to the list.
- **KEY-6 Selection as context.** With `selectionContext: true`, while a file row with an absolute path is
  selected, each submitted prompt gets one context line: `The user has <relative path> selected in the File
  Viewer panel; "this file" or "this" may refer to it.` Off by default.

## Recording file actions

- **REC-1 Tools.**

  | Tool | Records |
  |---|---|
  | Read | a read of the returned lines (COV-2) |
  | Edit, NotebookEdit | an edit with its line counts |
  | Write | a write: the whole file seen |
  | Grep | a hit per file named in the result (max 200), marked `?` |
  | Glob | a listing per file (max 200), marked `?` |
  | Bash | parsed actions (REC-3), Bash writes (GIT-4), cwd changes (REC-5) |

- **REC-2 Outcomes.** A `deny`, or an error whose text says the permission settings denied it, is `denied`; any
  other error is `error`. Both are logged and listed in the detail, with no coverage, tokens or light.
- **REC-3 Bash parsing.** Commands split on `;`, `&&`, `||`, `&`, newlines and pipes; env assignments and `time`,
  `command`, `nohup`, `builtin`, `exec`, `sudo` prefixes are skipped; heredocs and subshells end the parse.
  - Reads: `cat`, `nl` (whole), `head`/`tail` (`-n N`, `-N`, `tail -n +N`), `sed -n 'A,Bp'` (several ranges,
    `$`), `sed Nq`, `awk` (lines unknown). Byte counts (`-c`), other sed scripts and a reader feeding a pipe
    record a read with unknown lines. `sed -i` and `sed -f` record nothing.
  - Search hits: `grep`, `egrep`, `fgrep`, `rg`, also run through `xargs`. A file is named by `path:line:` output,
    by bare lines of `-l`/`--files` output only when that search alone writes stdout, and by a single searched
    file when the output has no names. Count mode skips `:0` lines. Filters that keep lines (`head`, `tail`,
    `sort`, `uniq`, a plain `grep`) still pass names through.
  - Listings: `find` output lines, `ls <file>`, and `wc` (which also teaches the line count).
  - Git verbs are classified (`commit` arms GIT-5).
  - At most 200 hits or listings per command.
- **REC-4 Path validation.** A hit or listing becomes a row only when its path is an existing file on disk (never a
  folder) or a path git reports deleted. A Bash read of a path that does not exist is kept with `?`.
- **REC-5 Working directory per agent.** Each agent's Bash directory starts at the session root and follows `cd`
  between calls. Claude Code's `Shell cwd was reset to <dir>` note wins. `cd -`, `cd "$VAR"`, a substitution or
  a glob make the directory unknown until an absolute or `~` `cd`; relative paths read meanwhile are recorded as
  `unresolved:<path>` rows with `?` and a fallback note. A compaction never moves the session root.
- **REC-6 Path spelling.** On macOS a path through `/tmp`, `/var` or `/etc` and its `/private` form are stored in
  the session root's spelling, so one file never shows twice.

## Coverage

- **COV-1** Each file keeps merged line intervals and a total. Coverage % = lines covered ÷ total.
- **COV-2 Read.** The interval is `[startLine, startLine + numLines − 1]` from the result. The total is
  `totalLines − 1` when the file ends with a newline (checked from the returned content, or the file on disk when
  the read stopped early; when unknown, a newline is assumed and the row gets `?`). A token-capped read covers
  only the returned page. Images, PDFs and notebooks are whole, or unknown lines when `pages` was given. A
  `file_unchanged` stub adds tokens but no lines and no read.
- **COV-3 Bash reads** place their lines from the parsed range, the output line count when one file produced all
  output, and the file's total (read from disk when needed). A `<persisted-output>` preview counts only the
  preview's lines and marks the read `?`.
- **COV-4 Edits.** An edit with a patch shifts every interval through the hunks, so coverage stays on the same
  content. Lines Claude wrote count as seen ("authored") with no read cost; a later read moves them to read. Line
  counts are the minimal diff as received (`+2 −0`, not `+5 −3`). An edit with no patch takes its counts from the
  strings, shifts nothing and gets `?`. A Write marks the whole file seen and authored.
- **COV-5 States:** `full`, `partial`, `partial-unknown` (a read whose lines are unknown), `hit`, `capped` (an
  auto-load Claude Code cut short), `none`.
- **COV-6 Meter.** A read file's gutter shows its share: `●` only at 100%, `○` only at 0%, and in between the
  nearest partial step, never empty or full: plain `◔` (under 37.5%), `◑` (under 62.5%), `◕`; Nerd Font slices 1–7
  of 8. A read whose total is unknown draws `●` when known whole, else `◔`. The meter's colour is `instruction`
  when the file's latest action is a Claude Code load, else the latest of commit (`commit`) and edit (`edit`),
  else `read`.
- **COV-7 `coverage: fill`** also tints the first round(coverage × width) cells of the row: `fill` read,
  `fill.edit` edited since, `fill.commit` committed since, pulled toward the background by `fill.darkness`. An
  out-of-context row gets a dimmer tint.
- **COV-8 Re-reads.** A read overlapping lines already seen (or a whole read of a seen file) counts as a re-read
  (`↩n`), per agent.

## Tokens

- **TOK-1** An estimate is `ceil(length / 4)` of the UTF-16 text Claude received: the tool result's model-facing
  text, the loaded instruction content, or the attachment text.
- **TOK-2** A file's cost is the sum of its reads, stubs and loads. Re-reads count again. A Bash command's text
  is split evenly across the files it read.
- **TOK-3** Edit, Write and NotebookEdit payloads are "written" tokens, shown only in the detail, never in cost.
- **TOK-4 Formats.** `≈850 tok`, `≈1.2k tok`, `≈12k tok`, `≈1.2M tok`, `≈? tok` when unknown; the right column and
  footer drop ` tok` but keep `≈`. Exact: `25,283 tok (exact)` in full, `context 25k exact` in the footer,
  `=25k` beside a legend.
- **TOK-5 Exact usage.** Each `turn.step` usage is kept per agent. Context = input + cache read + cache creation
  of a request. Billed ∑ = that sum over every request, including cache re-reads; it is never called context.
  Output is summed too.
- **TOK-6 Dedup.** A file's instruction or re-injection load counts once per agent per epoch, whichever signals
  report it (InstructionsLoaded, `prompt.context`, attachments, a resumed process). A deliberate tool re-read
  still counts.
- **TOK-7 In context now.** Each file keeps the ≈ tokens it holds in the main context since the last compaction.
  The footer's `files` figure and the Instructions summary's in-context share sum these.
- **TOK-8** Loads by agents with no known type (Claude Code's own forks) are kept in history and shown as `other`
  in the agents view, outside file totals.

## Instruction files

- **INST-1 Classification.** By path: plugin files under `.claude/plugins/{cache,marketplaces}/<market>/<plugin>/`,
  skill files under `.claude/skills/<name>/`, memory under `.claude/projects/*/memory/*.md`, rules under
  `.claude/rules/`, `CLAUDE.local.md`, `CLAUDE.md`, `AGENTS.md`. Origins: managed, user, project, local, memory,
  skill, plugin, skill description. Mode: auto-loaded, read via tool, or both.
- **INST-2 Sources.**

  | Source | Gives |
  |---|---|
  | `classic.InstructionsLoaded` | reason, memory type, trigger, parent, globs, agent; no content |
  | `prompt.context` result | every session-start file with its loaded content; files other mods add; reason `include` for imports, `agents-md` for AGENTS.md, `compact` after a compaction |
  | `nested_memory` attachment | content of nested CLAUDE.md and path-scoped rules |
  | `skill_listing` attachment | one `skill-description:<name>` row per skill (`plugin:skill` names belong to the plugin) |
  | `skill.prompt` | the SKILL.md body; its path from the `Base directory for this skill:` line |
  | `invoked_skills`, `file` attachments | skills and reads re-injected after a compaction |

  Other attachment types are recorded as injected text and not drawn.
- **INST-3 Lengths.** Lines count the raw file on disk; when Claude Code stripped front matter, the detail notes
  how many lines Claude received.
- **INST-4 MEMORY.md** comes from `prompt.context`. Its loaded lines are the leading lines shared with the file on
  disk; fewer than the file makes it `capped` (meter at that share, ≈ of the loaded part only).
- **INST-5 Fallbacks.** AGENTS.md always carries `?`. The detail of MEMORY.md and AGENTS.md says they were
  detected via fallback (found in `prompt.context`). A skill description whose SKILL.md was found only by
  scanning `<root>/.claude/skills` and `~/.claude/skills` is marked `?`, and so is a SKILL.md with no
  base-directory line.
- **INST-6 Owners.** Files under a skill's folder (learned from its SKILL.md load) or a plugin folder belong to it
  and group under it in the Instructions tab.

## Compaction

- **COMP-1** A `classic.SessionStart` with source `compact` starts a new epoch and is written to the log at once.
  Every file in the main context leaves it (`⊘`, dimmed, out of the `files` total) with its history kept.
- **COMP-2** Skill descriptions stay in context: each carries into the new epoch as one fresh load (tokens counted
  again, reason `compact`, `⟳`); the listing Claude Code re-sends in that epoch adds nothing.
- **COMP-3** A file Claude Code re-injects (InstructionsLoaded `compact`, `prompt.context`, a `file` or
  `invoked_skills` attachment) re-enters the context as one fresh load and gets `⟳`. A file not re-injected stays
  out until read again.

## Git

- **GIT-1 Snapshot.** Read-only commands in the session root: `rev-parse --show-toplevel`,
  `status --porcelain=v1 -z --untracked-files=all`, `diff --numstat HEAD`,
  `rev-list --left-right --count @{u}...HEAD`, `branch --show-current`, `rev-parse HEAD`,
  `rev-parse --abbrev-ref --symbolic-full-name @{u}`. 5 s timeout each. Outside a repo there is no git state.
- **GIT-2 Refresh.** After a Bash call, after Edit/Write/NotebookEdit, on a change to `.git/index` or `.git/HEAD`,
  on prompt submit, when the person focuses the pane, when `/files` opens, and on `↻`. At most one run per 2 s; a
  request inside the window runs once at its end, and a request during a run runs once after it.
- **GIT-3 Letters.** `A`, `M`, `D`, `R` (renames and copies), `?` untracked, `!` ignored; staged when the index
  side changed. Rename numstat keys on the new path; quoted paths are unquoted.
- **GIT-4 Bash writes.** After a Bash call, files whose status or counts changed since the previous snapshot are
  recorded as writes (new files) or edits, attributed to main, with no coverage. Files Edit/Write changed and
  staging alone (`??` → `A`) are excluded.
- **GIT-5 Commits.** A successful Bash call whose command has a `commit` verb (or whose output shows a commit sha)
  arms the next snapshot. If HEAD moved, every file in `git diff --name-only <old> <new>` gets a commit event with
  the sha: the row lights, the gutter shows `◆`, the footer chip shows `✓ committed <sha7>`. A failed commit arms
  nothing.
- **GIT-6 Branch row repo.** The session repo, or, when the focus is in an outside repo, that repo's snapshot.
  Focus above the session root but inside its repo keeps the session repo; focus above every repo shows no branch
  row.
- **GIT-7 Outside repos** run the same read-only commands in their own top level, each on its own 2 s throttle,
  only while the panel is open and the repo's Tree section is open, its Touched group is open on that tab, or the
  focus is inside it. Their snapshots colour the rows already in their section and add none.

## Outside roots and focus

- **ROOT-1 Resolution.** A touched path outside the session root belongs to the first match: the deepest added
  directory (from `/add-dir` via `classic.DirectoryAdded`, or `permissions.additionalDirectories` in the
  project's `.claude/settings.json`, `.claude/settings.local.json` and the user's settings, read once per session
  start); the git top level of its folder (`git -C <dir> rev-parse --show-toplevel --show-prefix`, cached per
  folder, after a render); the nearest ancestor holding `package.json`, `Cargo.toml`, `pyproject.toml` or `go.mod`;
  its parent folder. Paths under `~/.claude/` and Claude Code loads never make a section.
- **ROOT-2 Loose roots.** Home, `/` and a folder holding the session root never become a root through the first
  three rules. A file directly in one gets a section that holds only its own files and absorbs no other root.
- **ROOT-3 Sections** appear in order of first touch; a root inside another outside root merges into the outer
  one. The header shows the repo icon, the home-shortened root, the file count and the ≈ total. Sections and the
  folders holding touched files inside them are open by default; a press closes them. Folders on the way to
  touched files are listed one level at a time with `$.fs.list` (no full walk), which gives the fold counts.
- **ROOT-4 Focus** (view only; totals and recording do not change). Enter, or a double press, on a folder or
  section header focuses it: the Tree shows only that subtree and the breadcrumb shows its path. `↑` focuses the
  parent, above the session root too, listing one level at a time; `⌂` returns. Focus inside an outside section
  uses that section's git and folds.

## Subagents

- **AGENT-1 Registry.** A subagent is registered from `classic.SubagentStart` (type), `agent.spawn` (task
  description, parent) and `classic.SubagentStop` (done), in any order. Its label is `<type>#n`, n counting agents
  of that type by start. Claude Code's own forks (empty type) are never listed.
- **AGENT-2 Attribution** uses `tool.call` `agentId`, `InstructionsLoaded` `agent_id`, attachment `agentId` and
  `turn.step` `agentId`. Each file keeps each agent's ranges, reads, re-reads and ≈ tokens apart; they sum to the
  file's figures.
- **AGENT-3 Viewpoint.** With no subagent the lists show everything. Once one exists, main is the viewpoint by
  default; `a` or a click on an agent changes it. Gutter cell 0, ranges, re-reads, ≈ tokens, tab counts and the
  detail's history become that agent's. Instruction and context facts belong to main only.
- **AGENT-4 Badge.** Gutter cell 1 names the other agents that touched a file: `E` Explore, `G` general-purpose,
  `P` Plan, `C` any other type, `+` two or more types, `m` main (seen from a subagent). Bold on a `selection`-colour
  chip; while that agent has a call in flight on the file the chip turns `read` with background-coloured text.
- **AGENT-5 Agents line.** One line under the tab strip: `▸ main · C db-migrator ◌ · E Explore#7 ◌ · +9 done   ≈41k`.
  The viewpoint's agent leads, then running agents (`◌`) in start order, then finished ones (`✓`, latest first)
  while they fit; the rest fold into `+N running` / `+N done` (or `+N`). The right end is every agent's ≈ total. A
  name drops `#1` when it is the only agent of its type.
- **AGENT-6 Agents list.** `▸` expands the line into a list of at most a third of the body, scrolling by page
  through `▴ N more` / `▾ N more` rows. Main first, running agents next, then finished ones; two or more finished
  agents of one type fold into `E Explore ×6 ✓ 14 files ≈22k`, which a press opens. Custom types show
  `(custom)`. Rows carry status, files, ≈ and the task description.

## Persistence

- **LOG-1** The session log is JSONL at `<transcript dir>/<session id>/file-viewer/log.jsonl`: a header
  `{t: header, v: 1}`, then one record per line (`event`, `usage`, `step`, `agent`, `injected`, `shell`).
  Replaying it through the reducer rebuilds the same view. Unknown lines are skipped.
- **LOG-2** The whole log is rewritten after 25 new records, at turn end, on Stop, PreCompact, SessionEnd and
  `session.end`, and at once on a compaction. A log over 3.8 million characters is not written.
- **LOG-3** On startup or resume the session's existing log is adopted ahead of anything recorded since; `/clear`
  starts empty; a fork starts from the new session's log.
- **LOG-4** After a `--plugin-dir` reload the log is adopted by the first hook that names the transcript, or by the
  first git run, which finds `<config dir>/projects/<root with non-alphanumerics as ->/<session id>.jsonl`. Panel
  state (folds, tab) resets.

## Settings

Set through Claude Code's plugin settings (`userConfig` in `.claude-plugin/plugin.json`):

| Setting | Values (default first) | Does |
|---|---|---|
| `glyphs` | `auto` · `nerd` · `plain` | icon set and meter steps (ICON-2) |
| `iconColor` | `language` · `muted` | file icons coloured by language, or all `muted` |
| `coverage` | `meter` · `fill` | gutter meter only, or also the row tint (COV-7) |
| `claudeCodeLoads` | `show` · `hide` | Claude Code loads in the Tree (TREE-5 to TREE-7) |
| `palette` | `hex` · `theme` | the viewer's own colours, or Claude Code theme names (PAL-5) |
| `motion` | `on` · `off` | name shimmer, or a static colour (ACT-4) |
| `selectionContext` | `false` · `true` | add a line naming the selected file to each prompt (KEY-6) |

The hooks module also reads two options that `plugin.json` does not declare: `prunedDirs` (a comma list replacing
TREE-1's list) and `palettePath` (replacing PAL-1's file path).

## Palette

- **PAL-1** Overrides live in `<config dir>/file-viewer.colors.json` (the config dir comes from the transcript
  path): flat keys `read`, `search`, `edit`, `commit`, `instruction`, `pending`, `error`, `git.A`, `git.M`,
  `git.D`, `git.R`, `git.untracked`, `git.ignored`, `added`, `removed`, `muted`, `accent`, `selection`, `text`,
  `fill`, `fill.edit`, `fill.commit` (each `#rgb` or `#rrggbb`), `fill.darkness` (0–1) and `theme`
  (`light`, `dark`, `auto`).
- **PAL-2 Validation.** A bad or unknown key keeps its default and logs one warning per key, once per version of
  the file. Malformed JSON, or anything but an object, falls back to the whole default palette. The panel never
  fails on it.
- **PAL-3 When changes apply.** On a render the file (by modified time) and Claude Code's theme are re-checked at
  most every 2 s. An idle panel does not redraw by itself; any key, click or Claude activity shows the change. No
  restart is needed.
- **PAL-4 Theme.** The file's `theme` wins; else Claude Code's `theme` setting (`light*` → light, `dark*` → dark);
  else dark, and the detail view shows "Theme unknown (Claude Code on auto); set `theme: light` if your terminal
  is light."
- **PAL-5 `palette: theme`** draws foregrounds with Claude Code theme names: `text`→`text`, `muted`→`inactive`,
  `accent`→`suggestion`, `git.A`/`git.untracked`/`added`→`diffAdded`, `git.D`/`removed`/`error`→`error`,
  `git.M`→`warning`. Other keys, fills, the selection, the background and the shimmer band stay hex.
- **PAL-6 Defaults.** Four sets in `src/palette.ts`: dark and light, each for truecolor and for 256 colours.
  State hues: read ice blue, edit rose, commit gold, instruction lavender. The 256-colour values stay distinct
  after the xterm-cube rounding. The light variant paints its own background (`#ffffff`) under the whole panel;
  the dark variant paints none and uses the terminal's.
- **PAL-7 Colour depth.** Read from the environment on every look check: none under `NO_COLOR` or `TERM=dumb`;
  truecolor for `COLORTERM=truecolor|24bit` or a truecolor `TERM` (ghostty, kitty, wezterm, alacritty, foot,
  contour, rio) unless inside tmux without `CLAUDE_CODE_TMUX_TRUECOLOR`; else 256 colours. Truecolor uses the
  brighter truecolor set and a fill tint of 30% of the state colour; 256 colours use saturated fill tints
  (navy, maroon, olive in dark). `fill.darkness` overrides either.
- **PAL-8 Contrast.** Every name and meta colour reaches 4.5:1 on the reference dark backgrounds `#000000`,
  `#1e1e1e`, `#262626` and on white for light, in truecolor and 256 colours; `muted` and `git.ignored` reach 3:1.
  Tests enforce this.

## Icons

- **ICON-1 Sets.** `plain`: `■` folder, open folder and repo, `·` file, `⚡` Claude Code load, `⎇` branch.
  `nerd`: Nerd Font folder, open folder, git repo, generic file, robot (Claude Code load) and git-branch glyphs,
  plus per-name and per-extension icons (ts, tsx, js, jsx, json, md, yaml, toml, sh, py, go, rs, rb, java, kt,
  swift, c, h, cpp, css, scss, html, svg, images, sql, lock, package.json, tsconfig.json, Dockerfile, Makefile,
  .gitignore, LICENSE, .env). Carets stay `▸ ▾` and header buttons stay Unicode in both sets. Language colours
  come from a fixed table; unknown types use the generic icon with no colour.
- **ICON-2 `glyphs: auto`** decides once, on the first render, and rows draw `plain` until then: `plain` off the
  terminal surface; `nerd` over SSH (`SSH_CONNECTION`/`SSH_TTY`) or when `TERM_PROGRAM` is Ghostty, WezTerm or kitty;
  else `nerd` when `fc-list ':charset=<codepoint>'` finds a font with the generic-file glyph or `~/Library/Fonts`
  holds a file named `*Nerd*`; else `plain`.
- **ICON-3 Width.** Width math counts a Private Use Area glyph as one cell and wide characters (`⚡`, CJK, emoji) as
  two. A row's width never depends on the glyph set.

## Known gaps

- Mouse on list rows (press to select, double press to focus, right-click copy, drag to scroll) is covered only by
  the test harness; injected mouse events do not reach the rows Client, so it has no live check.
- Bash writes are found only through `git status`: a file Bash writes outside a git repo, or in an ignored path,
  is not recorded, and every Bash write is attributed to main.
- chars ÷ 4 runs below real usage (about 1.3–2.0× on large reads, 2.0–2.3× on small ones). `src/calibration.ts`
  can fit a local correction from the logged usage, but the panel does not use it.
- A log over 3.8 million characters stops being written, so a very long session loses later activity on resume.
- In a subagent viewpoint the footer's `files` figure is ≈0: per-file context is tracked for main only.
