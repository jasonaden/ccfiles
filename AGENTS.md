# claude-file-viewer

A Claude Code **mod** (a plugin with a hooks module) that shows, in a docked side panel, which files Claude
touched, how much of each it read (line-range coverage), which instruction files are in context, git state,
subagent activity, and an **estimated** token cost per file.

- Behaviour: [`docs/agents/REQUIREMENTS.md`](docs/agents/REQUIREMENTS.md). Code wins when they disagree; fix
  the doc in the same change.
- Claude Code mod API facts the code relies on: [`docs/agents/PLATFORM.md`](docs/agents/PLATFORM.md).
- The authoritative API reference is the generated `mods/file-viewer/.claude-plugin/types/claude-code/index.d.ts`,
  written on each `--plugin-dir` load and gitignored. Trust it over web docs.

## Rules

1. **Observe only.** Never deny, rewrite tool arguments, results or prompts, or answer an event in Claude Code's
   place. Every hook returns `next(e)` or the untouched result of `await next(e)`. The only exceptions are the
   opt-in selection-as-context line on prompt submit and the git file watches added at session start.
2. **No network.** Never use `$.http`, `$.model` or `$.mcp`. `scripts/check.sh` fails if
   `claude plugin validate` lists them.
3. **Tokens are estimates.** Per-file figures are characters ÷ 4 of the text Claude received, always shown with
   `≈`. Only `turn.step` usage figures are exact, and they are labelled "exact".
4. **Fast hooks.** Call `next(e)` promptly and do parsing and state work after it returns. Animate only while a
   row is lit.
5. **State is never colour-only.** Every state has a glyph or label, and the palette is user-configurable.
6. **Glyphs stay in sync.** A glyph or key change in `src/view/glyphs.ts` must also change the tables in
   `README.md` and `docs/agents/REQUIREMENTS.md` (`scripts/check-glyphs.ts` checks this).

## Layout

| Path | What |
|---|---|
| `mods/file-viewer/hooks/register.ts` | the hooks module: event handlers, panel drawing, git, timers |
| `mods/file-viewer/hooks/rows.ts` | the rows Client: draws the list, hover, clicks, scroll, shimmer |
| `mods/file-viewer/src/` | pure logic: ingest, reducer, intervals, Bash parsing, tokens, git parsing, roots, palette |
| `mods/file-viewer/src/view/` | pure view code: rows, row anatomy, header, footer, detail and help views, icons |
| `mods/file-viewer/tests/` | unit and harness tests (`claude plugin test`) |
| `mods/file-viewer/scripts/check.sh` | the gate: strict validate, no-network check, type check, glyph check, tests |
| `fixtures/make-fixture.sh` | builds a scratch project for live checks |

## How to work here

- Write a failing `*.test.ts` with stubbed events, implement, then run `mods/file-viewer/scripts/check.sh`.
- Keep pure logic in plain modules with plain unit tests; keep hooks thin.
- Static-analysis rules from `claude plugin validate`: write `$.ns.method()` in full, use literal event names and
  literal `$.env.get('NAME')`, pass `$` only to top-level functions in the same file, use relative imports, and
  never use dynamic `import()`.
- The plugin `name` must not start with `claude-` (validate rejects it).
- Live check: `fixtures/make-fixture.sh /tmp/fv-fixture`, then
  `cd /tmp/fv-fixture && claude --plugin-dir <repo>/mods/file-viewer`, `/tui fullscreen`, `/files`, in a terminal
  at least 110 columns wide. Always regenerate the fixture outside this repo; this repo's own AGENTS.md and
  CLAUDE.md would otherwise become ancestors of the test project.
- Never print or commit secrets or personal data (emails, home-directory paths) in code, tests or docs.
