// ─────────────────────────────────────────────────────────────────
//  tests/period.test.ts — unit tests for src/lib/period.ts (M7.2)
//
//  Pure functions, no database. Covers the three cases M7.2 requires:
//  February with start day 28, year boundaries, and start day 1 matching the
//  calendar-month grouping the services used before M7.2
//  (`date.toISOString().slice(0, 7)`) exactly, on fixture data.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import {
  describePeriod,
  isValidPeriodStartDay,
  periodBoundaryDates,
  periodContaining,
  periodKeyOf,
  recentPeriods,
  toDateKey,
} from '../src/lib/period'

const d = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s)

function expectContiguous(periods: Array<{ start: string; end: string }>) {
  for (let i = 1; i < periods.length; i++) {
    expect(periods[i].start, `period ${i} should start where period ${i - 1} ends`).toBe(periods[i - 1].end)
  }
}

describe('February with start day 28', () => {
  it('Feb 27 belongs to the period Jan 28 – Feb 27', () => {
    const { start, end } = periodContaining(d('2026-02-27'), 28)
    expect(toDateKey(start)).toBe('2026-01-28')
    expect(toDateKey(end)).toBe('2026-02-28')
  })

  it('Feb 28 starts a new period, Feb 28 – Mar 27, 28 days in a non-leap year', () => {
    const p = describePeriod(periodContaining(d('2026-02-28'), 28).start, 28, d('2026-03-01'))
    expect(p.start).toBe('2026-02-28')
    expect(p.end).toBe('2026-03-28')
    expect(p.lastDay).toBe('2026-03-27')
    expect(p.daysInPeriod).toBe(28)
    expect(p.label).toBe('Feb 28 – Mar 27')
  })

  it('leap day Feb 29 falls inside the period that starts Feb 28 (29 days)', () => {
    const { start, end } = periodContaining(d('2028-02-29'), 28)
    expect(toDateKey(start)).toBe('2028-02-28')
    expect(toDateKey(end)).toBe('2028-03-28')
    expect(describePeriod(start, 28, d('2028-03-01')).daysInPeriod).toBe(29)
  })

  it('periods running through February are contiguous, with no gap or overlap', () => {
    const periods = recentPeriods(d('2026-04-10'), 28, 6)
    expectContiguous(periods)
    expect(periods.map((p) => p.start)).toEqual([
      '2025-10-28', '2025-11-28', '2025-12-28', '2026-01-28', '2026-02-28', '2026-03-28',
    ])
  })
})

describe('year boundaries', () => {
  it('Jan 5 with start day 10 belongs to Dec 10 – Jan 9 of the previous year', () => {
    const p = describePeriod(periodContaining(d('2026-01-05'), 10).start, 10, d('2026-01-05'))
    expect(p.start).toBe('2025-12-10')
    expect(p.end).toBe('2026-01-10')
    expect(p.label).toBe('Dec 10 – Jan 9')
  })

  it('with start day 1, Dec 31 is December and Jan 1 is January of the next year', () => {
    expect(periodKeyOf(d('2025-12-31'), 1)).toBe('2025-12-01')
    expect(periodKeyOf(d('2026-01-01'), 1)).toBe('2026-01-01')
  })

  it('the last millisecond before the start day stays in the old period', () => {
    expect(periodKeyOf(d('2026-01-09T23:59:59.999Z'), 10)).toBe('2025-12-10')
    expect(periodKeyOf(d('2026-01-10T00:00:00.000Z'), 10)).toBe('2026-01-10')
  })

  it('recent periods from mid-January with start day 20 span two years contiguously', () => {
    const periods = recentPeriods(d('2026-01-15'), 20, 3)
    expect(periods.map((p) => p.start)).toEqual(['2025-10-20', '2025-11-20', '2025-12-20'])
    expect(periods[2].end).toBe('2026-01-20')
    expectContiguous(periods)
  })
})

describe('start day 1 matches calendar-month grouping exactly', () => {
  // Every first and last day of every month 2024–2026 (including a leap year),
  // mid-month days, and last-millisecond timestamps.
  const fixture: Date[] = []
  for (let year = 2024; year <= 2026; year++) {
    for (let month = 0; month < 12; month++) {
      fixture.push(new Date(Date.UTC(year, month, 1)))
      fixture.push(new Date(Date.UTC(year, month, 15, 12, 30)))
      fixture.push(new Date(Date.UTC(year, month + 1, 0)))
      fixture.push(new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)))
    }
  }

  it('groups every fixture date into the same buckets as toISOString().slice(0, 7)', () => {
    const legacy = new Map<string, number>()
    const anchored = new Map<string, number>()
    for (const date of fixture) {
      const oldKey = date.toISOString().slice(0, 7)
      legacy.set(oldKey, (legacy.get(oldKey) ?? 0) + 1)
      const newKey = periodKeyOf(date, 1)
      anchored.set(newKey.slice(0, 7), (anchored.get(newKey.slice(0, 7)) ?? 0) + 1)
      expect(newKey, `${date.toISOString()}`).toBe(`${oldKey}-01`)
    }
    expect([...anchored.entries()]).toEqual([...legacy.entries()])
  })

  it('the 12 most recent periods are exactly the last 12 calendar months', () => {
    const periods = recentPeriods(d('2026-09-15'), 1, 12)
    const expected: string[] = []
    for (let i = 11; i >= 0; i--) expected.push(new Date(Date.UTC(2026, 8 - i, 1)).toISOString().slice(0, 10))
    expect(periods.map((p) => p.start)).toEqual(expected)
    expect(periods[11]).toMatchObject({ label: 'Sep 2026', longLabel: 'September', tickLabel: "Sep '26", end: '2026-10-01' })
    expectContiguous(periods)
  })
})

describe('in-progress marking', () => {
  it('reports the current period as in progress with the day number, and past ones as complete', () => {
    const [previous, current] = recentPeriods(d('2026-09-14T18:00:00.000Z'), 10, 2)
    expect(current).toMatchObject({ start: '2026-09-10', inProgress: true, dayOfPeriod: 5, daysInPeriod: 30 })
    expect(previous).toMatchObject({ start: '2026-08-10', inProgress: false, dayOfPeriod: 31, daysInPeriod: 31 })
  })
})

describe('period boundaries on day-based data', () => {
  it('marks the first date of each new period, never the first date overall', () => {
    const dates = ['2026-08-08', '2026-08-09', '2026-08-11', '2026-09-09', '2026-09-10', '2026-09-12']
    expect(periodBoundaryDates(dates, 10)).toEqual(['2026-08-11', '2026-09-10'])
    expect(periodBoundaryDates(dates, 1)).toEqual(['2026-09-09'])
  })
})

describe('validation', () => {
  it('accepts whole numbers 1–28 only', () => {
    for (const ok of [1, 10, 28]) expect(isValidPeriodStartDay(ok)).toBe(true)
    for (const bad of [0, 29, 31, -1, 1.5, NaN, '10', null, undefined]) {
      expect(isValidPeriodStartDay(bad), String(bad)).toBe(false)
    }
  })

  it('refuses an invalid start day instead of guessing', () => {
    expect(() => periodKeyOf(d('2026-01-01'), 29)).toThrow(RangeError)
    expect(() => recentPeriods(d('2026-01-01'), 1, 0)).toThrow(RangeError)
  })
})
