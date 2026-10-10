#!/usr/bin/env bash
# Generates a small fixture project for live checks. Usage: fixtures/make-fixture.sh [target-dir]
# Default target is /tmp/fv-fixture (outside this repo, so this repo's CLAUDE.md/AGENTS.md
# are NOT ancestors of the fixture and don't pollute InstructionsLoaded).
# Also seeds auto-memory MEMORY.md (260 lines) at ~/.claude/projects/<sanitized-path>/memory/.
set -euo pipefail
T="${1:-/tmp/fv-fixture}"
rm -rf "$T"; mkdir -p "$T"/{docs,sub,.claude/rules,.claude/skills/demo}
cd "$T"
for i in $(seq 1 1323); do echo "big.md line $i: lorem ipsum dolor sit amet, consectetur adipiscing elit."; done > big.md
{ echo "// small.ts — 40 lines"; for i in $(seq 2 39); do echo "export const v$i = $i; // line $i"; done; echo "// end of small.ts (line 40)"; } > small.ts
cat > CLAUDE.md <<'MD'
# Fixture project instructions
This is the File Viewer fixture repo. Keep answers short.
@docs/style.md
MD
cat > docs/style.md <<'MD'
# Style guide (imported from CLAUDE.md)
- Use two-space indentation.
- Prefer named exports.
MD
cat > sub/CLAUDE.md <<'MD'
# sub/ instructions
Files in sub/ are examples; never modify them without asking.
MD
mkdir -p sub2   # a folder for subagents to touch
printf '# sub2/ instructions\nsub2 is for subagent checks.\n' > sub2/CLAUDE.md
{ echo "// sub2/b.ts"; for i in $(seq 2 10); do echo "export const b$i = $i;"; done; } > sub2/b.ts
{ echo "// sub/a.ts"; for i in $(seq 2 20); do echo "export const a$i = $i;"; done; } > sub/a.ts
# Claude Code reads only `paths:` in rule frontmatter; `globs:` is the InstructionsLoaded payload field name.
cat > .claude/rules/ts.md <<'MD'
---
paths:
  - "**/*.ts"
---
# TypeScript rule (path-scoped)
Always use `const` over `let` in TypeScript files.
MD
# Control: `globs:` is not a rule frontmatter key, so this rule loads unscoped at startup (session_start).
cat > .claude/rules/globs-control.md <<'MD'
---
globs: ["**/*.ts"]
---
# Control rule (globs: front matter, loads unscoped)
This rule is the globs control and applies everywhere.
MD
cat > .claude/skills/demo/SKILL.md <<'MD'
---
name: demo
description: Demo skill for the File Viewer fixture. Use when the user says "run the demo skill".
---
# Demo skill
When invoked, read `reference.md` in this skill's directory (lines 1-200 only) and summarize it in one line.
MD
for i in $(seq 1 600); do echo "reference.md line $i: demo skill reference material."; done > .claude/skills/demo/reference.md
# AGENTS.md is present but not loaded while a CLAUDE.md exists.
printf '# AGENTS.md (fixture)\nAgents: prefer small diffs.\n' > AGENTS.md
if [ "${FV_AGENTS_ONLY:-0}" = 1 ]; then rm -f CLAUDE.md; fi   # AGENTS.md-only variant
git init -q -b main && git add -A && git -c user.email=fixture@example.com -c user.name=fixture commit -qm "fixture"
# Auto memory: ~/.claude/projects/<cwd with / and . replaced by ->/memory/MEMORY.md
SAN="$(echo "$T" | sed 's#[/.]#-#g')"
MEM="$HOME/.claude/projects/$SAN/memory"
mkdir -p "$MEM"
{ echo "# Memory index"; for i in $(seq 2 260); do echo "- memory line $i: fixture fact number $i"; done; } > "$MEM/MEMORY.md"
echo "fixture at $T; MEMORY.md at $MEM/MEMORY.md ($(wc -l < "$MEM/MEMORY.md") lines)"
wc -l big.md small.ts .claude/skills/demo/reference.md
