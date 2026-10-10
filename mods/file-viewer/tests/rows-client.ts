// Test helpers for the rows Client (hooks/rows.ts): read its lines from the drawn tree, rebuild one row as Text
// nodes (so fill/selection/width checks read the same as they did on Button rows), and click a row by pointer.
import type { RowLine } from '../hooks/rows.ts'

type Tree = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }
type Pointer = { type: 'down' | 'up' | 'move' | 'leave'; x: number; y: number; button?: 'left' | 'right'; in?: string }
type Ui = { drawn: () => Promise<unknown>; pointer: (e: Pointer) => Promise<void> }

function findClient(n: unknown): Tree | undefined {
  if (n === null || typeof n !== 'object') return undefined
  const t = n as Tree
  if (t.type === 'Client' && (t.key ?? t.props?.key) === 'rows') return t
  for (const c of t.children ?? []) {
    const hit = findClient(c)
    if (hit) return hit
  }
  return undefined
}

export async function clientLines(ui: Ui): Promise<RowLine[]> {
  const c = findClient(await ui.drawn())
  return ((c?.props?.props as { lines?: RowLine[] } | undefined)?.lines ?? []) as RowLine[]
}

export const lineText = (l: RowLine) => l.segs.map((s) => s.t).join('')

/** A row as Text nodes (color, backgroundColor, bold, underline per segment), or undefined when not drawn. */
export async function rowNode(ui: Ui, id: string) {
  const l = (await clientLines(ui)).find((x) => x.id === id)
  if (!l) return undefined
  return {
    type: 'Row',
    key: id,
    text: lineText(l),
    children: l.segs.map((s) => ({ type: 'Text', props: { color: s.c, backgroundColor: s.bg, bold: s.b, underline: s.u }, children: [s.t] })),
  }
}

/** Clicks a row (pointer down and up on its line), as a person does. */
export async function clickRow(ui: Ui, id: string): Promise<void> {
  const y = (await clientLines(ui)).findIndex((x) => x.id === id)
  if (y < 0) throw new Error(`row ${id} is not drawn`)
  await ui.pointer({ type: 'down', x: 2, y, button: 'left', in: 'rows' })
  await ui.pointer({ type: 'up', x: 2, y, button: 'left', in: 'rows' })
}
