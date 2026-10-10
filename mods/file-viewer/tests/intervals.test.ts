import { describe, expect, test } from 'claude-code/testing'
import { addRange, applyPatch, coveredLines, coverageRatio, formatRanges, isFull, shiftForHunks, subtract } from '../src/intervals.ts'

describe('interval sets', () => {
  test('a single read is kept as one interval', () => {
    expect(addRange([], [1, 200])).toEqual([[1, 200]])
  })

  test('overlapping reads merge (1–200 then 150–349 → 1–349)', () => {
    const merged = addRange(addRange([], [1, 200]), [150, 349])
    expect(merged).toEqual([[1, 349]])
    expect(formatRanges(merged)).toBe('1–349')
  })

  test('adjacent reads merge, gaps stay separate and sorted', () => {
    expect(addRange([[1, 10]], [11, 20])).toEqual([[1, 20]])
    expect(addRange([[30, 40]], [1, 10])).toEqual([[1, 10], [30, 40]])
    expect(addRange([[1, 10], [30, 40]], [5, 35])).toEqual([[1, 40]])
  })

  test('the input set is not mutated', () => {
    const before: [number, number][] = [[1, 10]]
    addRange(before, [5, 20])
    expect(before).toEqual([[1, 10]])
  })

  test('covered lines and ratio are clamped to the file length', () => {
    const set = addRange(addRange([], [1, 10]), [20, 2000])
    expect(coveredLines(set, 100)).toBe(91)
    expect(coverageRatio(set, 100)).toBe(0.91)
    expect(coverageRatio(set, null)).toBe(null)
  })

  test('1–200 of 1,323 is about 15%', () => {
    expect(Math.round((coverageRatio([[1, 200]], 1323) ?? 0) * 100)).toBe(15)
  })

  test('1–349 of 1,323 is 26%', () => {
    expect(Math.round((coverageRatio([[1, 349]], 1323) ?? 0) * 100)).toBe(26)
  })

  test('full means every line 1..total is covered', () => {
    expect(isFull([[1, 40]], 40)).toBe(true)
    expect(isFull([[1, 39]], 40)).toBe(false)
    expect(isFull([[1, 20], [21, 40]], 40)).toBe(true)
    expect(isFull([], 0)).toBe(true)
    expect(isFull([[1, 40]], null)).toBe(false)
  })

  test('formatRanges lists merged ranges with an en dash', () => {
    expect(formatRanges([[1, 200], [250, 250], [300, 349]])).toBe('1–200, 250, 300–349')
    expect(formatRanges([])).toBe('')
  })
})

describe('shift on edit', () => {
  // Hunks come from Edit's structuredPatch: old coordinates + the new size.
  test('replacing 3 lines with 5 shifts later intervals by +2', () => {
    const hunks = [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 5 }]
    expect(shiftForHunks([[1, 20], [100, 200]], hunks)).toEqual([[1, 20], [102, 202]])
  })

  test('hunks with context lines shift by their net size only', () => {
    // 3 context + 1 removed + 3 added + 3 context: oldLines 7, newLines 9 → +2
    const hunks = [{ oldStart: 47, oldLines: 7, newStart: 47, newLines: 9 }]
    expect(shiftForHunks([[60, 70]], hunks)).toEqual([[62, 72]])
  })

  test('an interval spanning the edit keeps its start and moves its end', () => {
    const hunks = [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 5 }]
    expect(shiftForHunks([[1, 100]], hunks)).toEqual([[1, 102]])
  })

  test('deleting lines shrinks or drops what was inside them', () => {
    const hunks = [{ oldStart: 10, oldLines: 5, newStart: 10, newLines: 0 }]
    expect(shiftForHunks([[1, 9], [10, 14], [20, 30]], hunks)).toEqual([[1, 9], [15, 25]])
  })

  test('several hunks accumulate their deltas', () => {
    const hunks = [
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 3 }, // +2
      { oldStart: 50, oldLines: 4, newStart: 52, newLines: 1 }, // −3
    ]
    expect(shiftForHunks([[20, 30], [60, 70]], hunks)).toEqual([[22, 32], [59, 69]])
  })

  test('shifted intervals that become adjacent are merged', () => {
    const hunks = [{ oldStart: 11, oldLines: 2, newStart: 11, newLines: 0 }]
    expect(shiftForHunks([[1, 10], [13, 20]], hunks)).toEqual([[1, 18]])
  })
})

describe('map through an edit patch', () => {
  // As Claude Code 2.1.295 reports it: insert 2 lines after line 3 of small.ts.
  const insert2 = [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 8, lines: [' l1', ' l2', ' l3', '+v3a', '+v3b', ' l4', ' l5', ' l6'] }]

  test('read 1–5, insert 2 after line 3 → kept 1–3 and 6–7, authored 4–5 (union 1–7)', () => {
    expect(applyPatch([[1, 5]], insert2)).toEqual({ kept: [[1, 3], [6, 7]], added: [[4, 5]] })
  })

  test('context lines Claude never saw stay uncovered; lines after the hunk shift', () => {
    expect(applyPatch([[20, 30]], insert2)).toEqual({ kept: [[22, 32]], added: [[4, 5]] })
    expect(applyPatch([], insert2)).toEqual({ kept: [], added: [[4, 5]] })
  })

  test('removed lines drop out', () => {
    const replace = [{ oldStart: 4, oldLines: 5, newStart: 4, newLines: 4, lines: [' a', '-b', '-c', '-d', '+x', '+y', ' e'] }]
    expect(applyPatch([[1, 10]], replace)).toEqual({ kept: [[1, 4], [7, 9]], added: [[5, 6]] })
  })

  test('several hunks accumulate their offsets', () => {
    const two = [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: [' a', '+n'] },
      { oldStart: 10, oldLines: 2, newStart: 11, newLines: 1, lines: [' p', '-q'] },
    ]
    expect(applyPatch([[1, 20]], two)).toEqual({ kept: [[1, 2], [4, 20]], added: [[3, 3]] })
  })

  test('hunks without lines (older logs) fall back to the net shift, nothing authored', () => {
    expect(applyPatch([[1, 20], [100, 200]], [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 5 }])).toEqual({ kept: [[1, 20], [102, 202]], added: [] })
  })

  test('subtract removes ranges', () => {
    expect(subtract([[1, 10]], [[4, 5]])).toEqual([[1, 3], [6, 10]])
    expect(subtract([[1, 10], [20, 30]], [[5, 25]])).toEqual([[1, 4], [26, 30]])
  })
})
