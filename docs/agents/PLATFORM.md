# Claude Code mod API: facts ccfiles relies on

Observed on Claude Code **2.1.295** (macOS and Linux, terminal, fullscreen layout). Subagent attribution was also
seen on 2.1.296. The generated types at `mods/ccfiles/.claude-plugin/types/claude-code/index.d.ts` are
written on every `--plugin-dir` load and are the authoritative API reference; trust them over web docs.

## Loading and tooling

- Mods are on by default from 2.1.287. A dev mod loads with `claude --plugin-dir <dir>` and hot-reloads on save.
  Mods load only in a trusted workspace.
- A plugin is a mod when `hooks/hooks.json` has a `modules` key. The plugin `name` must not start with `claude-`.
- `userConfig` entries in `plugin.json` arrive as the `options` argument of `register(on, options)`.
- `claude plugin validate [--strict] <dir>` runs the loader's static analysis. It prints `hooks:`, `calls:` (every
  `$.*` method found), env and state reads, and "gating hook without .catch" warnings. Rules it enforces:
  - write every call as `$.ns.method(...)` in full; never alias or destructure `$`;
  - pass `$` only to top-level functions in the same file;
  - event names in `on()` are string literals; one `on()` per event without a matcher;
  - environment reads are `$.env.get('NAME')` with a literal name;
  - imports are relative (plus `claude-code`); no dynamic `import()`.
- `claude plugin test` runs `*.test.ts` with no session or network. The test's `$` acts as Claude Code and fires
  events; `on('<event or api>', stub)` answers in Claude Code's place. Stubs must be registered before the first
  `$` call. `session.start` does not fire on its own.
- The `calls:` line is the place to prove a mod uses no `$.http`, `$.model` or `$.mcp`.

## Events

| Event | What it carries |
|---|---|
| `tool.call` | Tool args on `e` (`tool`, `tool_use_id`, `file_path`, `command`, …). `e.agentId` is set on a subagent's calls and absent on main's. `await next(e)` returns `{ deny?, isError?, result, text }`; `text` is what the model received. |
| `turn.step` | An async generator hook (`yield* next(e)`). The result has `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`) and `toolUses`. `e.agentId` names a subagent's request. |
| `prompt.context` | `instructionFiles: [{ path, kind, content, parent? }]`, `kind` one of `project`, `user`, `local`, `managed`, `memory`. Content is what was loaded: front matter stripped, caps applied. Fires once per conversation and again after `/compact`. Files other mods add (the built-in AGENTS.md handling) appear only in the **result** of `next(e)`, not the input. |
| `prompt.attachment` | `{ type, text, agentId? }`. Types used: `nested_memory` (`Contents of <abs path>:\n\n<content>`, for nested CLAUDE.md and path-scoped rules), `skill_listing` (header plus `- name: description` entries), `invoked_skills` and `file` (post-compact restores). Many other types exist (`environment`, `date`, `total_tokens_reminder`, …). |
| `skill.prompt` | `{ skill, text }`. `text` is the SKILL.md body, front matter stripped, starting `Base directory for this skill: <dir>`. |
| `prompt.submit` | `e.context` is a list of extra lines; returning `next({ ...e, context: [...] })` adds one. |
| `classic.InstructionsLoaded` | `file_path`, `memory_type`, `load_reason` (`session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`), `trigger_file_path`, `parent_file_path`, `globs`, `agent_id`, `agent_type`, `transcript_path`. No content. Never fires for auto-memory MEMORY.md or for AGENTS.md. |
| `classic.SessionStart` | `source` (`startup`, `resume`, `clear`, `fork`, `compact`), `transcript_path`, `cwd`. A `compact` start carries the Bash shell's current directory, not the project root. The result may add `watchPaths`. |
| `classic.FileChanged` | `file_path`; fires for paths a SessionStart result asked to watch. |
| `classic.SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`; Stop also `last_assistant_message`. Claude Code's own forks (compaction, memory, prompt suggestions) use an empty `agent_type`. |
| `agent.spawn` | `subagentType`, `description`, `parentAgentId`; the result holds the new `agentId`. |
| `classic.DirectoryAdded` | `{ directory, source }`. Fires for `/add-dir`. Nothing fires for `--add-dir` at launch. |
| `classic.UserPromptSubmit`, `classic.Stop` | Both carry `transcript_path`. |
| `ui.render` (`Pane`) | `e.props.bodyColumns`, `e.props.scroll.bodyRows`, `e.surface`, `e.requestId`. |
| `ui.scroll` | `by`, `component`, `origin.kind` (`person` for wheel, arrows, PgUp/PgDn, Home/End on a focused pane). |
| `ui.message` | `{ requestId, element, data, surface }`: what a Client module posted. |
| `ui.focus`, `ui.close` | Pane focus (with `origin.kind`) and close, by request id. |
| `command.run` | `e.presentation = { isFullscreen, columns }`. |

## Tool results

- **Read:** `result = { type, file: { filePath, content, startLine, numLines, totalLines, truncatedByTokenCap? } }`.
  `totalLines` counts the empty line after a final newline (a 1,323-line file reports 1324). A whole-file read
  over the token cap is cut to a page with `truncatedByTokenCap: true`. `type: 'file_unchanged'` is a short stub
  for a file already in context. Images, PDFs and notebooks use other types.
- **Edit:** `result.structuredPatch` is the minimal diff (`oldStart`, `oldLines`, `newStart`, `newLines`, `lines`
  with `+`/`-` prefixes). **Write:** `type: 'create'` or `originalFile: null` for a new file.
- **Bash:** `result = { stdout, stderr, interrupted, … }`. Large output reaches the model as a
  `<persisted-output>` block with `Preview (first …):` lines. After a `cd` outside the allowed directories
  Claude Code moves the shell back and says `Shell cwd was reset to <dir>`. The shell keeps `cd` between calls.
- A command blocked by permission settings comes back as `isError: true` with "denied by your permission
  settings" text, not as `deny`. `tool.check`'s decision does not tell whether a call ran.
- Grep and Glob are absent by default on macOS and Linux builds; searches arrive as Bash.
- `classic.PreToolUse` carries no agent id; use `tool.call`.
- Rule files are scoped by `paths:` front matter. A rule with `globs:` loads unscoped at startup (`globs` is only
  the field name in the InstructionsLoaded payload).

## `/compact`

The order is `classic.PreCompact`, `classic.SessionStart` (`source: compact`), then on the next request:
InstructionsLoaded with `compact` (and `include` for imports), a fresh `prompt.context`, `file` attachments that
re-inject some earlier reads (`Called the Read tool with the following input: {json}` then `Result of calling the
Read tool:` and numbered lines), `invoked_skills`, and the skill listing again. Path-scoped rules and nested
CLAUDE.md files come back as `file` attachments. Claude Code chooses which reads to re-inject.

## Panes and drawing

- A docked pane the user opens needs the fullscreen layout and at least 110 terminal columns (144 for one the user
  did not open). `$.ui.open` answers `{ isPlaced, reason? }`.
- `$.ui.invalidate('ui.render')` asks for a redraw. An idle pane is not redrawn unless something invalidates it.
- Theme colour names (`text`, `inactive`, `suggestion`, `success`, `warning`, `error`, `diffAdded`, …) work as
  `color` values in header `Text` and inside a Client, in truecolor and 256 colours.
- `$.config.list()` exposes `theme`. On `auto` the resolved light or dark is not exposed.
- Mods get no colour-depth API. Claude Code draws no colour under `NO_COLOR` or `TERM=dumb`; truecolor for
  `COLORTERM=truecolor|24bit` or a truecolor `TERM`; inside tmux it clamps to 256 colours unless
  `CLAUDE_CODE_TMUX_TRUECOLOR` is set (tmux.conf alone does not change it). In 256 colours a colour is drawn as the
  nearest xterm cell: greys on the grey ramp, others on the 6×6×6 cube with `round(v / 51)` per channel.
- Claude Code's light-theme pane background is `#eeeeee`.
- A Private Use Area glyph (Nerd Font icons, U+E000–U+F8FF and U+F0000–U+10FFFD) keeps rows exact when counted as
  one cell and followed by a space. Ghostty, WezTerm and kitty draw the Nerd Font symbols with no Nerd Font
  installed, so `fc-list` alone cannot detect them.
- `$.ui.copy({ text, surface })` copies to the clipboard. `$.ui.log(text)` logs one message.

## Keys and focus

- A Button `hotkey` must be one lowercase letter or digit. `/`, `?`, Space, Esc and Enter cannot be bound.
- A `plain` Button with a `hotkey` always draws an `x:` prefix, even with `dimColor`. A Button has no colour prop,
  and the search `Input` takes no background or colour from the mod.
- A hotkey Button inside a zero-width Box (`width: 0`, `overflow: 'hidden'`) is not drawn but still fires.
- `ctrl+x tab` gives the pane the keyboard and raises no `ui.focus`. Then only Button hotkeys reach the pane.
- A Client gets keys only after a click in it. `$.ui.focus` cannot target a Client (it denies: "no element … is
  drawn under that key"). After a click, every key reaches the Client's `onKey`.
- The focus ring must rest on a visible control. A ring moved to a zero-width element drops the keys back to the
  prompt.
- There is no call that releases a pane's keys. Closing the pane and opening it again without `focus` returns
  the keyboard to the prompt.

## Client modules

- A Client (`Client({ module: './rows.ts', props, width, height })`) runs on the drawing thread and imports nothing
  at run time. It has `surface.state`/`setState`, `surface.every(ms, fn)` (returns a stop function),
  `surface.onPointer` (`down`, `up`, `move`, `leave`; `button: 'right'`), `surface.onKey`, and `surface.post(data)`,
  which arrives in the hooks module as `ui.message`.
- `Date` on the drawing thread does not tick reliably; time double-clicks in the hooks module with `$.clock`.
- Injected mouse events (tmux `send-keys`) reach Buttons but not a Client.

## Files, processes and session

- `$.fs.write` refuses files over 4 MiB. `$.fs.list(dir)` returns `{ name, kind, size, mtimeMs, isLink }`; folders
  have no useful modified time. `$.fs.read` returns the text.
- `$.process.run(argv, { cwd, timeoutMs })` returns `{ exitCode, stdout }`; it is local only.
- `$.session.root()` is the project root and a shell `cd` does not move it. `$.session.id()` is the session id.
- The transcript lives at `<config dir>/projects/<cwd with every non-alphanumeric character as ->/<id>.jsonl`;
  the config dir is `CLAUDE_CONFIG_DIR`, else `~/.claude`.
- A `--plugin-dir` reload re-runs `register` with empty state and no SessionStart. The next hook that carries
  `transcript_path`, or a lookup of `<id>.jsonl` under the project folder, finds the session again.
- On macOS `/tmp`, `/var` and `/etc` are also reachable as `/private/tmp`, `/private/var`, `/private/etc`. Tool
  paths may arrive in either spelling, and `git rev-parse --show-toplevel` returns the `/private` one;
  `--show-prefix` gives the directory's place in the repo so the caller can keep its own spelling.
- `permissions.additionalDirectories` lives in `.claude/settings.json`, `.claude/settings.local.json` and the
  user's `settings.json`; no event announces it.
