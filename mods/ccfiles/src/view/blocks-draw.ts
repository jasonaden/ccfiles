// The detail, help and usage blocks drawn for desktop: boxes and text, with vectors for the line strip and the
// glyphs. Widths count cells, as everywhere on the panel; the text inside is the surface's own proportional font, so
// columns are Boxes, never padding, and a column is wider than its widest text counts in cells.
import type { BoxProps, ElementConstructor, RenderElement, SvgProps, TextProps } from 'claude-code'
import { mix, type ColorKey, type Palette } from '../palette.ts'
import type { Block } from './blocks.ts'
import type { Chip } from './rows.ts'
import { GLYPH_PX, glyphVector, strip } from './svg.ts'
import { cellWidth } from './text.ts'

/** The elements the drawing needs (desktop's table has them all). */
export type BlockElements = {
  readonly Box: ElementConstructor<BoxProps>
  readonly Text: ElementConstructor<TextProps>
  readonly Svg: ElementConstructor<SvgProps>
}

const chipsWidth = (cs: readonly Chip[]) => cs.reduce((n, c) => n + cellWidth(c.text), 0)
/** Cells a column of proportional text needs: capitals and wide letters run past one cell each. */
const roomFor = (cells: number) => Math.ceil(cells * 1.25)
/** The strip's height in CSS pixels; a stretched vector needs one given, or the surface draws it 150 tall. */
const STRIP_PX = 12

/** Blocks from `offset` on, as desktop elements, one gap row between blocks. */
export function drawBlocks(el: BlockElements, blocks: readonly Block[], p: Palette, offset = 0): RenderElement[] {
  const { Box, Text, Svg } = el
  const c = (k: ColorKey) => p.colors[k]
  const t = (s: string, color: string, o: TextProps = {}) => Text({ color, wrap: 'truncate', ...o, children: [s] })
  const chipText = (cs: readonly Chip[], o: TextProps = {}) => cs.map((x) => t(x.text, c(x.color), o))
  /** Chips as one wrapping run of text: a long list of ranges breaks onto more lines, never over its neighbours. */
  const flow = (cs: readonly Chip[]) => Text({ wrap: 'wrap', children: cs.map((m) => Text({ color: c(m.color), children: [m.text] })) })
  const heading = (s: string) => t(s.toUpperCase(), c('muted'))
  const card = mix(p.background, c('selection'), 0.55)

  const draw = (b: Block): RenderElement => {
    switch (b.kind) {
      case 'title':
        return Box({
          flexDirection: 'column',
          children: [
            Box({ flexDirection: 'row', children: [t(b.name, c('text'), { bold: true }), ...(b.mark ? [t(` ${b.mark}`, c('accent'))] : [])] }),
            ...(b.path ? [t(b.path, c('muted'))] : []),
          ],
        })
      case 'chips':
        return Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 1,
          rowGap: 0,
          children: b.chips.map((x) => Box({ flexDirection: 'row', paddingX: 1, backgroundColor: mix(p.background, c(x.color), 0.18), children: [t(x.text, c(x.color))] })),
        })
      case 'stats':
        return Box({
          flexDirection: 'row',
          columnGap: 1,
          children: b.items.map((s) =>
            Box({ flexDirection: 'column', width: 0, flexGrow: 1, flexShrink: 1, paddingX: 1, backgroundColor: card, children: [heading(s.label), t(s.value, c('text'), { bold: true }), t(s.sub, c('muted'))] }),
          ),
        })
      case 'strip': {
        const v = strip(b.total, b.spans.map((s) => ({ from: s.from, to: s.to, color: c(s.color) })), mix(p.background, c('selection'), 0.7))
        return Box({
          flexDirection: 'column',
          children: [
            heading('Lines read'),
            Box({ height: 1, flexDirection: 'column', justifyContent: 'center', children: [Svg({ source: v.source, alt: v.alt, height: STRIP_PX })] }),
            Box({ flexDirection: 'row', justifyContent: 'space-between', children: [t('1', c('muted')), t(b.total.toLocaleString('en-US'), c('muted'))] }),
            ...(b.ranges.length ? [flow(b.ranges)] : []),
            ...(b.legend.length ? [flow(b.legend)] : []),
          ],
        })
      }
      case 'table': {
        // Each column is as wide as its widest cell and two cells of gap; the last takes the rest.
        const widths = b.columns.map((col, i) => roomFor(Math.max(cellWidth(col.label), ...b.rows.map((r) => chipsWidth(r[i] ?? [])))) + 2)
        const row = (cells: readonly (readonly Chip[])[], key: string, head = false) =>
          Box({
            key,
            flexDirection: 'row',
            height: 1,
            children: b.columns.map((col, i) =>
              Box({
                ...(i === b.columns.length - 1 ? { flexGrow: 1, flexShrink: 1 } : { width: widths[i]!, flexShrink: 0 }),
                flexDirection: 'row',
                overflow: 'hidden',
                // A right-aligned column ends two cells short of the next, so its figures don't touch it.
                ...(col.right ? { justifyContent: 'flex-end', paddingRight: 2 } : {}),
                children: head ? [t(col.label, c('muted'))] : chipText(cells[i] ?? []),
              }),
            ),
          })
        return Box({ flexDirection: 'column', children: [...(b.title ? [heading(b.title)] : []), row([], 'head', true), ...b.rows.map((r, i) => row(r, `r${i}`))] })
      }
      case 'terms': {
        const w = roomFor(Math.max(...b.rows.map((r) => cellWidth(r.term.text)))) + 2
        return Box({
          flexDirection: 'column',
          children: [
            ...(b.title ? [heading(b.title)] : []),
            ...b.rows.map((r) => {
              const v = r.glyph ? glyphVector(r.term.text, c(r.term.color), 'fraction' in r.term ? r.term.fraction : null) : null
              return Box({
                flexDirection: 'row',
                children: [
                  Box({ width: w, flexShrink: 0, flexDirection: 'row', alignItems: 'center', children: [v ? Svg({ source: v.source, alt: v.alt, width: GLYPH_PX, height: GLYPH_PX }) : t(r.term.text, c(r.term.color))] }),
                  Box({ flexGrow: 1, flexShrink: 1, flexDirection: 'row', children: [flow(r.meaning)] }),
                ],
              })
            }),
          ],
        })
      }
      case 'heading':
        return heading(b.text)
      case 'note':
        return flow(b.chips)
    }
  }
  return blocks.slice(offset).map((b, i) => Box({ key: `block:${offset + i}`, flexDirection: 'column', ...(i > 0 ? { marginTop: 1 } : {}), children: [draw(b)] }))
}
