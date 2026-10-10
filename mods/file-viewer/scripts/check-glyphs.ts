// The glyph set in code (src/view/glyphs.ts, which the help view and legend draw from), the README table under
// "Glyphs and row meta" and the table under "## Glyphs" in docs/agents/REQUIREMENTS.md must list the same glyphs;
// the README's meanings must match the code's word for word.
// Every key the help view lists (KEY_TABLE) also has a row in the README's Keys table.
// Usage: node --experimental-strip-types mods/file-viewer/scripts/check-glyphs.ts
import { readFileSync } from 'node:fs'
import { GLYPH_TABLE, KEY_TABLE } from '../src/view/glyphs.ts'

const repo = new URL('../../../', import.meta.url)

/** `| \`●\` | read in full |` rows of the first glyph table after `heading`. */
function table(file: string, heading: RegExp): [string, string][] {
  const lines = readFileSync(new URL(file, repo), 'utf8').split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  if (start < 0) throw new Error(`${file}: no ${heading}`)
  const rows: [string, string][] = []
  for (const l of lines.slice(start + 1)) {
    const m = /^\s*\| `(.+?)` \| (.+?) \|\s*$/.exec(l)
    if (m) rows.push([m[1]!, m[2]!])
    else if (rows.length > 0) break
  }
  return rows
}

const code = GLYPH_TABLE.map((g) => [g.glyph, g.meaning] as [string, string])
const readme = table('README.md', /^## Glyphs and row meta/)
const requirements = table('docs/agents/REQUIREMENTS.md', /^## Glyphs$/)
const glyphs = (t: [string, string][]) => t.map(([g]) => g).join(' ')
let failed = false
for (const [name, t] of [['README.md', readme], ['docs/agents/REQUIREMENTS.md', requirements]] as const) {
  if (glyphs(t) !== glyphs(code)) {
    console.error(`FAIL: ${name} glyphs ${glyphs(t)} ≠ code ${glyphs(code)}`)
    failed = true
  }
}
if (JSON.stringify(readme) !== JSON.stringify(code)) {
  console.error(`FAIL: README meanings differ from src/view/glyphs.ts:\n${JSON.stringify(readme)}\n${JSON.stringify(code)}`)
  failed = true
}
const readmeText = readFileSync(new URL('README.md', repo), 'utf8')
const keysSection = readmeText.slice(readmeText.indexOf('## Keys'), readmeText.indexOf('## Glyphs and row meta'))
const readmeKeys = new Set(keysSection.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => [...l.split(' | ')[0]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)))
for (const k of KEY_TABLE.flatMap((k) => k.keys.split(' '))) {
  if (!readmeKeys.has(k)) {
    console.error(`FAIL: key ${k} (help view) has no row in README › Keys`)
    failed = true
  }
}
if (failed) process.exit(1)
console.log(`glyph table check: ok (${glyphs(code)})`)
