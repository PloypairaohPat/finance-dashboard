// ─────────────────────────────────────────────────────────────────
//  walkSeries — how a marked subscription is followed from its anchor.
//  Timing is the guard, not amount: a charge joins only inside the
//  window around a slot's expected date, whatever its price. Two slots
//  in a row with no charge end the series, and nothing revives it. An
//  anchor with nothing else has no known schedule.
//  Amounts and names are invented.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { walkSeries, type Charge } from '../src/lib/subscriptionSeries'

const DAY = 86_400_000
const NOW = new Date(Date.UTC(2026, 9, 4))
const SINCE = new Date(NOW.getTime() - 400 * DAY)
const on = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
let n = 0
const c = (date: Date, amount: number, id = `c${++n}`): Charge => ({ id, date, amount })
const ids = (cs: Charge[]) => cs.map((x) => x.id)
const walk = (anchor: Charge, all: Charge[], now = NOW) => walkSeries(anchor, all, { now, since: SINCE })

describe('walkSeries', () => {
  it('follows a monthly charge, and follows it to a new price', () => {
    const charges = [
      c(on(2026, 6, 5), 40, 'jun'), c(on(2026, 7, 6), 40, 'jul'),
      c(on(2026, 8, 4), 40, 'aug'), c(on(2026, 9, 5), 56, 'sep'),
    ]
    const s = walk(charges[0], charges)
    expect(s.period).toBe('MONTHLY')
    expect(ids(s.charges)).toEqual(['jun', 'jul', 'aug', 'sep'])
    expect(s.ended).toBe(false)
  })

  it('walks backwards from an anchor in the middle', () => {
    const charges = [c(on(2026, 6, 5), 40, 'a'), c(on(2026, 7, 5), 40, 'b'), c(on(2026, 8, 5), 40, 'c')]
    expect(ids(walk(charges[2], charges).charges)).toEqual(['a', 'b', 'c'])
  })

  it('does not take in a one-off purchase from the same merchant mid-cycle', () => {
    const charges = [
      c(on(2026, 6, 5), 40, 'jun'), c(on(2026, 7, 5), 40, 'jul'),
      c(on(2026, 7, 20), 25, 'one-off'),
      c(on(2026, 8, 5), 40, 'aug'), c(on(2026, 9, 5), 40, 'sep'),
    ]
    const s = walk(charges[0], charges)
    expect(s.period).toBe('MONTHLY')
    expect(ids(s.charges)).not.toContain('one-off')
    expect(ids(s.charges)).toEqual(['jun', 'jul', 'aug', 'sep'])
  })

  it('does not take a one-off after the last charge as the new price', () => {
    // The case only timing can settle: no regular charge competes for the slot.
    const charges = [
      c(on(2026, 6, 5), 40, 'jun'), c(on(2026, 7, 5), 40, 'jul'),
      c(on(2026, 8, 5), 40, 'aug'), c(on(2026, 9, 5), 40, 'sep'),
      c(on(2026, 9, 20), 60, 'one-off'),
    ]
    const s = walk(charges[0], charges)
    expect(ids(s.charges)).toEqual(['jun', 'jul', 'aug', 'sep'])
  })

  it('ends after two empty slots, and a later purchase does not revive it', () => {
    const charges = [
      c(on(2026, 3, 5), 40, 'mar'), c(on(2026, 4, 5), 40, 'apr'), c(on(2026, 5, 5), 40, 'may'),
      // cancelled: nothing on Jun 5 or Jul 5
      c(on(2026, 8, 5), 40, 'later'),
    ]
    const s = walk(charges[0], charges)
    expect(s.ended).toBe(true)
    expect(ids(s.charges)).toEqual(['mar', 'apr', 'may'])
  })

  it('does not end on a slot that is still open', () => {
    const charges = [c(on(2026, 7, 6), 40), c(on(2026, 8, 6), 40), c(on(2026, 9, 6), 40)]
    // Oct 6 is due but its window hasn't closed on Oct 4.
    expect(walk(charges[0], charges).ended).toBe(false)
  })

  it('has no schedule with only the anchor', () => {
    const anchor = c(on(2026, 9, 20), 120)
    const s = walk(anchor, [anchor, c(on(2026, 9, 2), 15)])
    expect(s.period).toBeNull()
    expect(ids(s.charges)).toEqual([anchor.id])
    expect(s.ended).toBe(false)
  })

  it('learns an annual schedule rather than assuming monthly', () => {
    const charges = [c(on(2025, 9, 12), 99, 'y1'), c(on(2026, 9, 14), 99, 'y2')]
    const s = walk(charges[1], charges)
    expect(s.period).toBe('ANNUALLY')
    expect(ids(s.charges)).toEqual(['y1', 'y2'])
  })

  it('tells weekly and biweekly from monthly', () => {
    const weekly = [0, 7, 14, 21, 28, 35].map((d) => c(new Date(on(2026, 8, 1).getTime() + d * DAY), 9))
    expect(walk(weekly[0], weekly).period).toBe('WEEKLY')
    const biweekly = [0, 14, 28, 42, 56].map((d) => c(new Date(on(2026, 7, 1).getTime() + d * DAY), 20))
    expect(walk(biweekly[0], biweekly).period).toBe('BIWEEKLY')
  })

  it('keeps to its own series when the merchant bills another one alongside', () => {
    // Two subscriptions from one merchant, a few days apart each month.
    const small = [c(on(2026, 6, 5), 2.99, 's1'), c(on(2026, 7, 5), 2.99, 's2'), c(on(2026, 8, 5), 3.99, 's3')]
    const big = [c(on(2026, 6, 8), 10.99, 'b1'), c(on(2026, 7, 8), 10.99, 'b2'), c(on(2026, 8, 8), 10.99, 'b3')]
    const all = [...small, ...big]
    expect(ids(walk(small[0], all).charges)).toEqual(['s1', 's2', 's3'])
    expect(ids(walk(big[0], all).charges)).toEqual(['b1', 'b2', 'b3'])
  })

  it('does not count slots before what it can see as missed', () => {
    const anchor = c(on(2025, 1, 10), 40, 'old-anchor')
    const visible = [c(on(2026, 8, 10), 40, 'aug'), c(on(2026, 9, 10), 40, 'sep')]
    const s = walkSeries(anchor, [anchor, ...visible], { now: NOW, since: on(2026, 7, 1) })
    expect(s.ended).toBe(false)
    expect(ids(s.charges)).toEqual(['old-anchor', 'aug', 'sep'])
  })
})
