import { describe, expect, test } from 'claude-code/testing'
import { estTokens, fmtEstTokens, fmtExactTokens, unmarkedTokenFigures } from '../src/tokens.ts'

describe('token estimate (chars ÷ 4)', () => {
  test('rounds up characters ÷ 4', () => {
    expect(estTokens('')).toBe(0)
    expect(estTokens('abc')).toBe(1)
    expect(estTokens('abcd')).toBe(1)
    expect(estTokens('abcde')).toBe(2)
    expect(estTokens('x'.repeat(14_691))).toBe(3673)
  })
})

describe('rendering', () => {
  test('every estimated figure carries the ≈ marker', () => {
    for (const n of [0, 1, 999, 1000, 1234, 9_999, 12_345, 999_999, 1_234_567]) {
      expect(fmtEstTokens(n)).toStartWith('≈')
      expect(unmarkedTokenFigures(fmtEstTokens(n))).toEqual([])
    }
    expect(fmtEstTokens(850)).toBe('≈850 tok')
    expect(fmtEstTokens(1234)).toBe('≈1.2k tok')
    expect(fmtEstTokens(12_345)).toBe('≈12k tok')
    expect(fmtEstTokens(1_234_567)).toBe('≈1.2M tok')
    expect(fmtEstTokens(null)).toBe('≈? tok')
  })

  test('exact API figures are labeled exact and never use the estimate marker', () => {
    expect(fmtExactTokens(25_283)).toBe('25,283 tok (exact)')
    expect(fmtExactTokens(25_283)).not.toContain('≈')
    expect(unmarkedTokenFigures(fmtExactTokens(25_283))).toEqual([])
  })

  test('the checker finds token figures with neither marker nor exact label', () => {
    expect(unmarkedTokenFigures('big.md 1.3k  3.7k tok')).toEqual(['3.7k tok'])
    expect(unmarkedTokenFigures('total 12,000 tokens')).toEqual(['12,000 tokens'])
    expect(unmarkedTokenFigures('~3.7k tok · ≈12k tok · 5 tok (exact)')).toEqual([])
  })
})
