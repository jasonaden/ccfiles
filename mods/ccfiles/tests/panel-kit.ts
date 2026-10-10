// Panel helpers for the panel tests: a docked pane at a given size, the host calls the panel makes, and the drawn
// pane as lines (the same reading as panel.test.ts).
import type { On } from 'claude-code'
import type { RowLine } from '../hooks/rows.ts'
import { lineText } from './rows-client.ts'

type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

export const pane = (bodyColumns = 60, bodyRows = 16) =>
  ({
    plugin: 'ccfiles',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ccfiles',
    viewport: { columns: 160, rows: 45, isFullscreen: true },
    props: { title: 'ccfiles', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }) as const

/** Stubs Claude Code's theme, the pane, the log, the clipboard and the focus ring. */
export function host(on: On, theme = 'dark') {
  on('config.list', () => ({ value: [{ key: 'theme', kind: 'choice', value: theme, options: [] }] as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } as never }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
}

/** What a node shows, as the person reads it (a Box gap draws as blank cells, a plain Button as `key: label`). */
export function textOf(n: unknown): string {
  if (typeof n === 'string') return n
  if (n === null || typeof n !== 'object') return ''
  const node = n as Node
  // The hidden hotkey Buttons sit in a zero-width Box, which draws nothing.
  if (node.type === 'Box' && node.props?.width === 0) return ''
  const kids = node.children ?? []
  const hot = node.type === 'Button' && node.props?.hotkey ? `${node.props.hotkey}: ` : ''
  const gap = node.type === 'Box' && typeof node.props?.gap === 'number' ? ' '.repeat(node.props.gap) : ''
  if (kids.length > 0) return hot + kids.map(textOf).join(gap)
  if (node.type === 'Input') return `${String(node.props?.label ?? '')} ${String(node.props?.value || node.props?.placeholder || '')}`
  return ''
}

/** The drawn pane as lines: one per child of the root column, one per line the rows Client draws. */
export async function screen(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const root = (await ui.drawn()) as Node
  return (root.children ?? []).flatMap((c) => {
    const n = c as Node
    if (n.type === 'Client') return ((n.props?.props as { lines?: RowLine[] })?.lines ?? []).map(lineText)
    return [textOf(n)]
  })
}
