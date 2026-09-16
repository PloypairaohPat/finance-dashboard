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
    if (projected <= amount) continue

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
