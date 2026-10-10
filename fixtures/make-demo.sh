#!/usr/bin/env bash
# Builds a small TypeScript project with git history and one local change, plus a separate
# repo at <dir>-shared for an outside-root section. Used for the README screenshots.
# Usage: fixtures/make-demo.sh [target-dir]   (default /tmp/ccfiles-demo)
set -euo pipefail
D="${1:-/tmp/ccfiles-demo}"
rm -rf "$D"; mkdir -p "$D"/{src/routes,src/db,src/lib,tests,docs,.claude/rules}
cd "$D"
gen() { # file, header, n functions
  local f="$1" h="$2" n="$3"; { echo "$h"; echo; for i in $(seq 1 "$n"); do cat <<TS
/** Helper $i: keeps the handler small and testable. */
export function step$i(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input, step: $i }
  if (Object.keys(out).length > 12) throw new Error('too many fields at step $i')
  return out
}

TS
done; } > "$f"; }
cat > package.json <<'J'
{ "name": "tasks-api", "version": "1.4.0", "type": "module",
  "scripts": { "dev": "tsx watch src/server.ts", "test": "vitest run" },
  "dependencies": { "hono": "^4.6.0", "drizzle-orm": "^0.36.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "tsx": "^4.19.0" } }
J
cat > tsconfig.json <<'J'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "outDir": "dist" } }
J
cat > CLAUDE.md <<'M'
# tasks-api

Small HTTP API for tasks and users (Hono + Drizzle on SQLite).

- Run tests with `npm test`; keep handlers thin, logic in `src/lib`.
- Schema changes need a migration note in `docs/api.md`.
M
cat > .claude/rules/testing.md <<'M'
---
paths: ["tests/**"]
---
Tests use vitest. One `describe` per route. No network.
M
gen src/server.ts "import { Hono } from 'hono'
import { tasks } from './routes/tasks.ts'
import { users } from './routes/users.ts'

export const app = new Hono().route('/tasks', tasks).route('/users', users)" 6
gen src/routes/tasks.ts "import { Hono } from 'hono'
import { db } from '../db/client.ts'
import { requireUser } from '../lib/auth.ts'

// TODO: paginate the list endpoint
export const tasks = new Hono()" 22
gen src/routes/users.ts "import { Hono } from 'hono'
import { db } from '../db/client.ts'

export const users = new Hono()" 14
gen src/db/schema.ts "import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const tasks = sqliteTable('tasks', { id: integer('id').primaryKey(), title: text('title').notNull(), done: integer('done').default(0) })" 10
gen src/db/client.ts "import { drizzle } from 'drizzle-orm/better-sqlite3'

export const db = drizzle(process.env.DB_PATH ?? 'tasks.db')" 4
gen src/lib/auth.ts "// TODO: rotate session secrets
export function requireUser(token: string | undefined) { if (!token) throw new Error('unauthorized'); return { id: token } }" 12
gen src/lib/validate.ts "export const isTitle = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length < 200" 8
gen tests/tasks.test.ts "import { describe, it, expect } from 'vitest'
import { app } from '../src/server.ts'" 9
{ echo '# API'; echo; for r in tasks users; do for v in GET POST PATCH DELETE; do printf '## %s /%s\n\nReturns JSON. Errors use `{ error }` with a 4xx status.\n\n' "$v" "$r"; done; done; } > docs/api.md
cat > README.md <<'M'
# tasks-api

`npm run dev`, then `curl localhost:3000/tasks`.
M
printf 'node_modules/\ndist/\n*.db\n' > .gitignore
git init -q -b main && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "tasks-api 1.4.0"
# a local change before the session starts
sed -i '' 's/too many fields/too many fields (max 12)/' src/lib/validate.ts
S="$D-shared"
rm -rf "$S"; mkdir -p "$S/src"; cd "$S"
printf 'export type Task = { id: number; title: string; done: boolean }\nexport type User = { id: string; name: string }\n' > src/task.ts
printf '# shared-types\n' > README.md
git init -q -b main && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
