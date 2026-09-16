import type { Detector, DetectedAlert } from "../types"
import { currentPeriod } from "../types"
import { PAYMENTS_TO_PEOPLE } from "../../../lib/classifier"
import { spendByBucket } from "../../classification.service"

// M7.3: these read the same figure the budget cards show — same classifier, same
// money period, same payment-app cap. Before, the detector summed calendar-month
// spending with its own rules, so for anyone whose period didn't start on the 1st
// the alert and the card it referred to described different windows: a card could
// read "on track" while the alert said "over budget".

function spendByCategory(ctx: Parameters<Detector>[0]): Record<string, number> {
  const period = currentPeriod(ctx)
  return spendByBucket(ctx.classified, period.key, ctx.startDay, ctx.paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
}

export const detectBudgetExceeded: Detector = (ctx) => {
  const out: DetectedAlert[] = []
  const period = currentPeriod(ctx)
  const spendByCat = spendByCategory(ctx)

  for (const b of ctx.budgets) {
    const spent = spendByCat[b.category] ?? 0
    const amount = Number(b.monthlyLimit)
    if (spent < amount) continue

    const over = spent - amount
    out.push({
      kind: "budget_exceeded" as const,
      fingerprint: `budget_exceeded:${b.category}:${period.key}`,
      severity: "high" as const,
      title: `${b.category} budget exceeded`,
      body: `You've spent $${spent.toFixed(0)} against a $${amount.toFixed(0)} budget — over by $${over.toFixed(0)}.`,
      data: { category: b.category, period: period.key, spent, amount, over },
    })
  }
  return out
}

/**
 * How far a projection must fall BELOW the limit before the alert resolves.
 *
 * A projection is volatile early in a period, so resolving the moment it dips
 * under the limit makes the alert flicker on and off day to day. Measured on the
 * demo seed — five completed periods times five budgets, 590 day-to-day moves:
 * the median move is 5.3% of the limit, p75 is 10.1% and p90 is 18.0%. Simulating
 * bands against that history: no band flips the alert 50 times, 10% flips 34
 * times, 15% flips 26, 20% flips 25, 25% flips 23. 15% is the knee — it removes
 * about half the flicker, and wider bands buy one or two fewer flips while
 * leaving a resolved-in-fact alert standing longer.
 */
const PROJECTION_RESOLVE_BAND = 0.15

export const detectBudgetProjectedOver: Detector = (ctx) => {
  const out: DetectedAlert[] = []
  const period = currentPeriod(ctx)
  // Pace only means something once a period is under way, and only while it is
  // still running. Measured against the period, not the calendar month.
  if (!period.inProgress || period.dayOfPeriod < 7) return out

  const spendByCat = spendByCategory(ctx)
  const periodNoun = ctx.startDay === 1 ? "month-end" : "the end of the period"

  for (const b of ctx.budgets) {
    const spent = spendByCat[b.category] ?? 0
    const amount = Number(b.monthlyLimit)
    if (spent >= amount) continue
    const projected = (spent / period.dayOfPeriod) * period.daysInPeriod
    // Hysteresis: once firing, keep firing until the projection is a clear band
    // under the limit. Fires at the limit, resolves at 85% of it.
    const alreadyFiring = ctx.activeAlerts.has(`budget_proj:${b.category}:${period.key}`)
    const holdAbove = alreadyFiring ? amount * (1 - PROJECTION_RESOLVE_BAND) : amount
    if (projected <= holdAbove) continue

    const projectedOver = projected - amount
    out.push({
      kind: "budget_projected_over" as const,
      fingerprint: `budget_proj:${b.category}:${period.key}`,
      severity: "medium" as const,
      title: `${b.category} pacing over budget`,
      body: `At your current pace you'll hit $${projected.toFixed(0)} by ${periodNoun} — $${projectedOver.toFixed(0)} over the $${amount.toFixed(0)} budget.`,
      data: { category: b.category, period: period.key, spent, amount, projected, projectedOver },
    })
  }
  return out
}
