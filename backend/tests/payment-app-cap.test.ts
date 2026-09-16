// ─────────────────────────────────────────────────────────────────
//  tests/payment-app-cap.test.ts — D5: what to do with a payment-app surplus
//
//  Three candidate rules, measured against the seed's five completed periods
//  and against a synthetic series shaped like a habitual net receiver (which is
//  what the calibrated data actually looks like: payment-app inflows
//  substantially outnumber outflows).
//
//  These tests exist to make the trade-off visible and permanent. Whichever
//  option ships, the other two stay measured here, so "we chose this knowing
//  what it costs" survives in the repo.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import { buildDemoDataset } from '../prisma/demo-dataset'
import { carryForward, perPeriodCap, totals, type PeriodFlow } from '../src/lib/paymentApp'

const ds = buildDemoDataset(new Date('2026-09-15T12:00:00.000Z'))
const seedFlows: PeriodFlow[] = ds.paymentApp.map((p) => ({ key: p.periodKey, out: p.out, in: p.in }))

/** A habitual net receiver: paid back more than they pay out, month after month. */
const netReceiver: PeriodFlow[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ key: `2026-0${i + 1}-01`, out: 50, in: 120 })),
  { key: '2026-09-01', out: 900, in: 0 }, // …and then one month of real payments
]

describe('the seed series is ordered and matches the manifest', () => {
  it('is oldest period first', () => {
    expect([...seedFlows.map((f) => f.key)].sort()).toEqual(seedFlows.map((f) => f.key))
    expect(seedFlows).toHaveLength(5)
  })
})

describe('option (a): each period stands alone', () => {
  const series = perPeriodCap(seedFlows)

  it('reproduces the manifest period by period', () => {
    series.forEach((p, i) => {
      expect(p.spend, p.key).toBeCloseTo(ds.paymentApp[i].netSpend, 2)
      expect(p.surplus, p.key).toBeCloseTo(ds.paymentApp[i].surplus, 2)
    })
  })

  it('overstates the multi-period total by exactly the sum of surpluses', () => {
    const t = totals(series)
    const trueNet = Math.max(0, t.out - t.in)
    expect(t.spend).toBeCloseTo(209.75, 2)
    expect(trueNet).toBeCloseTo(96.25, 2)
    expect(t.spend - trueNet).toBeCloseTo(t.surplus, 2)
    expect(t.surplus).toBeCloseTo(113.5, 2)
  })
})

describe('option (c): carry the surplus forward', () => {
  const series = carryForward(seedFlows)

  it('satisfies the identity: sum of spend = out - in + final carry', () => {
    const t = totals(series)
    expect(t.spend).toBeCloseTo(t.out - t.in + t.carryFinal, 2)
  })

  it('lands on 96.25 for the seed, with nothing left carrying', () => {
    const t = totals(series)
    expect(t.spend).toBeCloseTo(96.25, 2)
    expect(t.carryFinal).toBeCloseTo(0, 2)
    expect(series.map((p) => p.spend)).toEqual([43.25, 0, 46.5, 0, 6.5])
  })

  it('never restates a closed period: each period only reads carry from before it', () => {
    // Period i's carryIn is period i-1's carryOut, so closing i-1 fixes i.
    series.forEach((p, i) => {
      expect(p.carryIn, p.key).toBeCloseTo(i === 0 ? 0 : series[i - 1].carryOut, 2)
    })
  })

  // ── the two failure modes ──────────────────────────────────────

  it('FAILURE 1: a windowed view imports error from outside the window', () => {
    // The app never shows "all time" — it shows the last N periods. Over the
    // last three, the identity says nothing, because carry crosses the edge.
    const window = seedFlows.slice(2)
    const windowTruth = window.reduce((s, f) => s + f.out - f.in, 0)
    const inWindowA = perPeriodCap(seedFlows).slice(2).reduce((s, p) => s + p.spend, 0)
    const inWindowC = series.slice(2).reduce((s, p) => s + p.spend, 0)

    expect(windowTruth).toBeCloseTo(129.75, 2)
    expect(inWindowA).toBeCloseTo(166.5, 2) // (a) overstates by the window's own surplus
    expect(inWindowC).toBeCloseTo(53, 2) // (c) understates, using carry earned before the window
    expect(Math.abs(inWindowC - windowTruth)).toBeGreaterThan(Math.abs(inWindowA - windowTruth))
  })

  it('FAILURE 2: carry ratchets for a net receiver and suppresses a later real payment', () => {
    const c = carryForward(netReceiver)
    const carries = c.slice(0, 8).map((p) => p.carryOut)
    // Eight periods of being paid back build an ever-growing credit…
    expect(carries).toEqual([70, 140, 210, 280, 350, 420, 490, 560])
    expect(carries.every((v, i) => i === 0 || v > carries[i - 1])).toBe(true)
    // …which then swallows most of a month in which $900 genuinely went out.
    expect(c[8].spend).toBeCloseTo(340, 2)
    expect(perPeriodCap(netReceiver)[8].spend).toBeCloseTo(900, 2)
  })
})

describe("option (c'): carry forward, but a surplus expires", () => {
  it('bounds the carry to one period and reports what aged out', () => {
    const c = carryForward(netReceiver, 1)
    expect(c.every((p) => p.carryOut <= 70)).toBe(true)
    expect(totals(c).expired).toBeCloseTo(490, 2) // seven surpluses aged out unused
    // The later real payment is reduced only by the most recent surplus.
    expect(c[8].spend).toBeCloseTo(830, 2)
  })

  it('leaves the seed unchanged, because its surpluses are used immediately', () => {
    expect(carryForward(seedFlows, 1).map((p) => p.spend)).toEqual(
      carryForward(seedFlows).map((p) => p.spend),
    )
  })
})
