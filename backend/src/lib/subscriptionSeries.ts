// ─────────────────────────────────────────────────────────────────
//  subscriptionSeries — follow a marked subscription from the charge the
//  user marked (its anchor) through the other charges of the same merchant.
//
//  TIMING IS THE GUARD, NOT AMOUNT. A charge joins the series only if it
//  lands inside a window around a slot's expected date, whatever its price.
//  That is what lets a mark follow a price change — the reason marks exist
//  for price-up — while a one-off purchase from the same merchant mid-cycle
//  stays out. When a slot's window holds several charges, the one closest in
//  price to the series joins; the others recur alongside it and are a
//  different subscription (one merchant, several plans).
//
//  ENDING. Two consecutive slots whose windows have closed with no charge
//  end the series. Nothing after that joins, so a later purchase can't
//  revive a cancelled subscription; the user can mark again. A slot whose
//  window is still open isn't missed yet, and a slot before what the caller
//  can see (`since`) is unknown rather than missed.
//
//  SCHEDULE. Learned, never assumed. Each candidate period is walked from the
//  anchor and scored hits minus misses; the period needs a second charge to
//  count at all. With only the anchor the schedule is unknown (null), so an
//  annual charge is never mistaken for a monthly one.
// ─────────────────────────────────────────────────────────────────

export type Period = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'ANNUALLY'

export interface Charge {
  id: string
  date: Date
  amount: number
}

export interface Series {
  /** Members, oldest first. Always includes the anchor. */
  charges: Charge[]
  /** null when only the anchor is known: the schedule can't be told yet. */
  period: Period | null
  /** Two slots in a row passed with no charge. */
  ended: boolean
}

const DAY_MS = 86_400_000

/**
 * The step, and how far either side of the expected date a charge may land.
 * Windows scale with the period: card charges post a day or two late, and a
 * monthly bill moves with month lengths and weekends; an annual one drifts more.
 */
const PERIODS: ReadonlyArray<{ period: Period; windowDays: number; step: (d: Date, k: number) => Date }> = [
  { period: 'WEEKLY', windowDays: 2, step: (d, k) => new Date(d.getTime() + 7 * k * DAY_MS) },
  { period: 'BIWEEKLY', windowDays: 3, step: (d, k) => new Date(d.getTime() + 14 * k * DAY_MS) },
  { period: 'MONTHLY', windowDays: 5, step: (d, k) => addMonths(d, k) },
  { period: 'ANNUALLY', windowDays: 10, step: (d, k) => addMonths(d, 12 * k) },
]

/** Calendar months in UTC, the day clamped to the target month's length. */
function addMonths(d: Date, k: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + k
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)))
}

interface Walked {
  charges: Charge[]
  hits: number
  misses: number
  ended: boolean
}

function walk(
  anchor: Charge,
  pool: Charge[],
  p: (typeof PERIODS)[number],
  bounds: { now: Date; since: Date },
): Walked {
  const w = p.windowDays * DAY_MS
  const used = new Set([anchor.id])
  let misses = 0

  /** The charge for one slot: inside the window, closest in price to `ref`. */
  const pick = (expected: Date, ref: number, after: Date | null, before: Date | null) => {
    const lo = expected.getTime() - w
    const hi = expected.getTime() + w
    const inWindow = pool.filter((c) =>
      !used.has(c.id) &&
      c.date.getTime() >= lo && c.date.getTime() <= hi &&
      (after === null || c.date > after) && (before === null || c.date < before))
    inWindow.sort((a, b) =>
      Math.abs(a.amount - ref) - Math.abs(b.amount - ref) ||
      Math.abs(a.date.getTime() - expected.getTime()) - Math.abs(b.date.getTime() - expected.getTime()) ||
      a.id.localeCompare(b.id))
    return { charge: inWindow[0] ?? null, lo, hi }
  }

  // Forward from the anchor: up to now, or until two empty slots end it.
  const forward: Charge[] = []
  let ended = false
  {
    let base = anchor.date
    let last = anchor
    let empty = 0
    for (;;) {
      const expected = p.step(base, 1)
      const { charge, lo, hi } = pick(expected, last.amount, last.date, null)
      if (charge) {
        forward.push(charge); used.add(charge.id)
        base = charge.date; last = charge; empty = 0
        continue
      }
      if (hi > bounds.now.getTime()) break          // still open: not missed yet
      base = expected
      if (lo < bounds.since.getTime()) continue     // before what we can see: unknown
      misses++; empty++
      if (empty >= 2) { ended = true; break }
    }
  }

  // Backward from the anchor: to where the subscription began, or out of sight.
  const backward: Charge[] = []
  {
    let base = anchor.date
    let first = anchor
    let empty = 0
    for (;;) {
      const expected = p.step(base, -1)
      const { charge, lo } = pick(expected, first.amount, null, first.date)
      if (lo < bounds.since.getTime() && !charge) break
      if (charge) {
        backward.unshift(charge); used.add(charge.id)
        base = charge.date; first = charge; empty = 0
        continue
      }
      base = expected
      misses++; empty++
      if (empty >= 2) break
    }
  }

  const charges = [...backward, anchor, ...forward]
  return { charges, hits: charges.length, misses, ended }
}

export function walkSeries(anchor: Charge, charges: readonly Charge[], bounds: { now: Date; since: Date }): Series {
  const pool = charges.filter((c) => c.id !== anchor.id)
  let best: { p: Period; w: Walked } | null = null
  for (const p of PERIODS) {
    const w = walk(anchor, pool, p, bounds)
    if (w.hits < 2) continue
    const score = w.hits - w.misses
    // Ties go to the longer period: a monthly charge also lands on every
    // other biweekly slot, but it is not a biweekly subscription.
    if (!best || score >= best.w.hits - best.w.misses) best = { p: p.period, w }
  }
  if (!best) return { charges: [anchor], period: null, ended: false }
  return { charges: best.w.charges, period: best.p, ended: best.w.ended }
}
