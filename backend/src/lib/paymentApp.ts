// ─────────────────────────────────────────────────────────────────
//  paymentApp.ts — how payment-app inflows reduce payment-app spend.
//
//  Payment-app money in (Venmo, Zelle, Cash App…) is not income: it is people
//  paying you back. It reduces what you paid out. The question is what happens
//  when a period's inflows exceed its outflows, which for a habitual net
//  receiver is most periods. Three answers, all pure arithmetic on a series of
//  per-period totals, so the choice is one call site and not a rewrite:
//
//    perPeriodCap   (D5 option a) — the surplus is shown and then dropped.
//    carryForward   (D5 option c) — the surplus funds later periods' payments.
//    carryForward(_, n)  (option c') — the same, but a surplus expires after
//                                      n periods.
//
//  Neither (a) nor (c) is neutral, and the tests in tests/payment-app-cap.test.ts
//  pin both identities and both failure modes:
//
//    (a)  Σ spend − max(0, Σout − Σin)  =  Σ surplus     ← a permanent residue,
//         one per period where inflows exceeded outflows.
//    (c)  Σ spend  =  Σout − Σin + carry_final           ← correct over all
//         time, but a period's figure can be reduced by money that arrived
//         long before it, and the app never shows "all time" anyway.
//
//  Money is handled in integer cents throughout: these figures are summed
//  across periods and compared against reported totals, so float drift is not
//  acceptable.
// ─────────────────────────────────────────────────────────────────

export interface PeriodFlow {
  /** Period key (YYYY-MM-DD of the period start). */
  key: string
  /** Total payment-app money out in this period, positive. */
  out: number
  /** Total payment-app money in this period, positive. */
  in: number
}

export interface PeriodSpend extends PeriodFlow {
  /** What "Payments to people" reports as spend for this period. */
  spend: number
  /** Inflow this period that no outflow absorbed. */
  surplus: number
  /** Unspent surplus brought in from earlier periods (carry modes only). */
  carryIn: number
  /** Unspent surplus leaving for later periods (carry modes only). */
  carryOut: number
  /** Carry that aged out unused before it could be applied (c' only). */
  expired: number
}

const cents = (n: number) => Math.round(n * 100)
const money = (c: number) => c / 100

/**
 * D5 option (a): each period stands alone. Inflow reduces this period's
 * payment-app spend down to zero and no further; anything left over is
 * reported as surplus and never applied anywhere.
 */
export function perPeriodCap(flows: readonly PeriodFlow[]): PeriodSpend[] {
  return flows.map((f) => {
    const out = cents(f.out)
    const inflow = cents(f.in)
    return {
      ...f,
      spend: money(Math.max(0, out - inflow)),
      surplus: money(Math.max(0, inflow - out)),
      carryIn: 0,
      carryOut: 0,
      expired: 0,
    }
  })
}

/**
 * D5 option (c): a surplus is carried forward and offsets later periods'
 * payment-app outflows, oldest surplus first.
 *
 * `memoryPeriods` bounds how long a surplus may wait (option c'). The default
 * is unbounded, which is the form that satisfies the identity above; a finite
 * memory trades that identity for a bounded distortion, and reports whatever
 * aged out in `expired` so the difference stays auditable.
 */
export function carryForward(
  flows: readonly PeriodFlow[],
  memoryPeriods: number = Number.POSITIVE_INFINITY,
): PeriodSpend[] {
  // Surplus is held in dated buckets so it can be spent oldest-first and, when
  // memoryPeriods is finite, expire in the order it was earned.
  let buckets: Array<{ cents: number; age: number }> = []
  const total = () => buckets.reduce((s, b) => s + b.cents, 0)

  return flows.map((f) => {
    const out = cents(f.out)
    const inflow = cents(f.in)
    const carryIn = total()

    let remaining = out - inflow
    let surplus = 0

    if (remaining > 0) {
      // This period paid out more than came in: draw down the carry.
      for (const bucket of buckets) {
        if (remaining <= 0) break
        const used = Math.min(bucket.cents, remaining)
        bucket.cents -= used
        remaining -= used
      }
      buckets = buckets.filter((b) => b.cents > 0)
    } else if (remaining < 0) {
      // More came in than went out: the excess becomes new carry.
      surplus = -remaining
      buckets.push({ cents: surplus, age: 0 })
      remaining = 0
    }

    let expired = 0
    if (Number.isFinite(memoryPeriods)) {
      buckets = buckets.filter((b) => {
        if (b.age >= memoryPeriods) {
          expired += b.cents
          return false
        }
        return true
      })
    }
    for (const b of buckets) b.age += 1

    return {
      ...f,
      spend: money(remaining),
      surplus: money(surplus),
      carryIn: money(carryIn),
      carryOut: money(total()),
      expired: money(expired),
    }
  })
}

/** Convenience: totals across a computed series, for the identity checks. */
export function totals(series: readonly PeriodSpend[]) {
  const sum = (f: (p: PeriodSpend) => number) => money(series.reduce((s, p) => s + cents(f(p)), 0))
  return {
    out: sum((p) => p.out),
    in: sum((p) => p.in),
    spend: sum((p) => p.spend),
    surplus: sum((p) => p.surplus),
    expired: sum((p) => p.expired),
    carryFinal: series.length === 0 ? 0 : series[series.length - 1].carryOut,
  }
}
