// ─────────────────────────────────────────────────────────────────
//  tests/savings-rate-floor.test.ts — the floor under the savings rate (M7.3)
//
//  Plan §7 recorded a savings rate of -8431.6%, which is what you get when a
//  period with almost no income is divided into a normal month of spending. The
//  floor suppresses the figure instead of clamping it: a real -40% period must
//  still read -40%, but a period with $12 of income says nothing at all.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { SAVINGS_RATE_FALLBACK_FLOOR, savingsRateFor } from '../src/services/classification.service'

describe('the savings-rate floor', () => {
  it('falls back to $100 when no completed period had income', () => {
    const r = savingsRateFor(500, 100, [])
    expect(r.floor).toBe(SAVINGS_RATE_FALLBACK_FLOOR)
    expect(r.rate).toBe(20)
  })

  it('ignores completed periods with no income when taking the median', () => {
    const r = savingsRateFor(5000, 1000, [0, 0, 4000])
    expect(r.floor).toBe(1000) // 25% of 4000, the only period with income
  })

  it('uses the median, not the mean, so one odd period cannot move it far', () => {
    const r = savingsRateFor(5000, 500, [4000, 4200, 40000])
    expect(r.floor).toBe(1050) // 25% of the median, 4200
  })

  it('averages the two middle values when only two periods had income', () => {
    const r = savingsRateFor(5000, 500, [4000, 5000])
    expect(r.floor).toBe(1125) // 25% of 4500
  })

  it('looks at the last three periods with income, not every period', () => {
    const r = savingsRateFor(5000, 500, [100000, 4000, 4000, 4000])
    expect(r.floor).toBe(1000) // the ancient 100k period is out of scope
  })

  it('suppresses the rate when income is under the floor', () => {
    const r = savingsRateFor(12, -4000, [4800, 5000, 5200])
    expect(r.floor).toBe(1250)
    expect(r.rate).toBeNull()
    expect(r.suppressed).toBe(true)
  })

  it('reports no income as absent rather than suppressed', () => {
    const r = savingsRateFor(0, -2000, [4800, 5000, 5200])
    expect(r.rate).toBeNull()
    expect(r.suppressed).toBe(false)
  })

  it('never clamps a real rate, in either direction', () => {
    expect(savingsRateFor(5000, -2000, [4800, 5000, 5200]).rate).toBe(-40)
    expect(savingsRateFor(5000, 4900, [4800, 5000, 5200]).rate).toBe(98)
  })

  it('shows a rate exactly at the floor, and hides it one cent below', () => {
    const incomes = [4800, 5000, 5200]
    expect(savingsRateFor(1250, 250, incomes).rate).toBe(20)
    expect(savingsRateFor(1249.99, 250, incomes).rate).toBeNull()
  })
})
