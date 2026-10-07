// The missed-paycheck backtest's pure parts (scripts/lib): banking days and
// paydays. All dates are invented.

import { describe, expect, it } from 'vitest'
import { addBusinessDays, businessDaysAfter, federalReserveHolidays, isBusinessDay } from '../scripts/lib/businessDays'
import { exclusionOf, nominalSchedule, paydays, wouldFire } from '../scripts/lib/paycheckBacktest'

const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

describe('banking days', () => {
  it('skips weekends and Federal Reserve holidays, observing a Sunday holiday on Monday but not moving a Saturday one', () => {
    expect(isBusinessDay(d('2026-10-09'))).toBe(true)   // a Friday
    expect(isBusinessDay(d('2026-10-10'))).toBe(false)  // Saturday
    expect(isBusinessDay(d('2026-10-12'))).toBe(false)  // Columbus Day
    expect(isBusinessDay(d('2026-11-26'))).toBe(false)  // Thanksgiving
    // 4 July 2027 is a Sunday: observed Monday the 5th.
    expect(isBusinessDay(d('2027-07-05'))).toBe(false)
    // 4 July 2026 is a Saturday: not moved, so Friday the 3rd is a banking day.
    expect(isBusinessDay(d('2026-07-03'))).toBe(true)
    expect(federalReserveHolidays(2026).size).toBe(11)
  })

  it('counts grace in banking days', () => {
    // Friday 9 Oct 2026 + 1 banking day skips the weekend and Columbus Day.
    expect(iso(addBusinessDays(d('2026-10-09'), 1))).toBe('2026-10-13')
    // A payday on a Saturday counts from the Monday.
    expect(iso(addBusinessDays(d('2026-10-17'), 0))).toBe('2026-10-19')
    expect(businessDaysAfter(d('2026-10-09'), d('2026-10-13'))).toBe(1)
    expect(businessDaysAfter(d('2026-10-09'), d('2026-10-08'))).toBe(0) // early is on time
  })
})

describe('paydays', () => {
  it('qualifies only mature, active, fixed-schedule salary inflows', () => {
    const ok = { direction: 'inflow', pfcDetailed: 'INCOME_SALARY', status: 'MATURE', isActive: true, frequency: 'BIWEEKLY' }
    expect(exclusionOf(ok)).toBeNull()
    expect(exclusionOf({ ...ok, pfcDetailed: 'INCOME_INTEREST_EARNED' })).toBe('not a salary code')
    expect(exclusionOf({ ...ok, pfcDetailed: 'INCOME_CONTRACTOR' })).toBe('not a salary code')
    expect(exclusionOf({ ...ok, status: 'EARLY_DETECTION' })).toBe('not mature')
    expect(exclusionOf({ ...ok, isActive: false })).toBe('inactive')
    expect(exclusionOf({ ...ok, frequency: 'UNKNOWN' })).toBe('no fixed frequency')
    expect(exclusionOf({ ...ok, frequency: 'ANNUALLY' })).toBe('no fixed frequency')
  })

  it("a monthly payday paid early for a weekend doesn't make the next month's look late", () => {
    // The 15th: Thu 15 Jan, Fri 13 Feb (15th a Sunday), Sun 15 Mar paid Fri 13th, Wed 15 Apr.
    const deposits = ['2026-01-15', '2026-02-13', '2026-03-13', '2026-04-15'].map(d)
    const p = paydays(deposits, 'MONTHLY', d('2026-04-30'))
    expect(p.map((x) => iso(x.expected))).toEqual(['2026-02-15', '2026-03-15', '2026-04-15'])
    expect(p.map((x) => x.lateBy)).toEqual([0, 0, 0])
  })

  it('a payday with no deposit is "never", and the schedule carries on after it', () => {
    const deposits = ['2026-09-04', '2026-09-18', '2026-10-16'].map(d) // 2 Oct missing
    const p = paydays(deposits, 'BIWEEKLY', d('2026-10-20'))
    expect(p.map((x) => [iso(x.expected), x.lateBy])).toEqual([['2026-09-18', 0], ['2026-10-02', null], ['2026-10-16', 0]])
  })

  it('late by banking days, and the grace decides', () => {
    const deposits = ['2026-09-04', '2026-09-18', '2026-10-06'].map(d) // 2 Oct paid Tue 6 Oct
    const [, late] = paydays(deposits, 'BIWEEKLY', d('2026-10-10'))
    expect(late.lateBy).toBe(2)
    expect(wouldFire(late, 1)).toBe(true)
    expect(wouldFire(late, 2)).toBe(false)
  })

  it('semi-monthly on the 15th and the last day: the last day whatever the month length', () => {
    const s = nominalSchedule(['2026-01-15', '2026-01-31', '2026-02-13', '2026-02-27'].map(d), 'SEMI_MONTHLY', d('2026-04-30'))
    expect(s.map(iso)).toEqual(['2026-01-31', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30'])
  })
})
