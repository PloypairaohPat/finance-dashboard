import type { Detector } from "../types"
import { currentPeriod, priorPeriods } from "../types"
import { PAYMENTS_TO_PEOPLE } from "../../../lib/classifier"
import { spendByBucket } from "../../classification.service"

const THRESHOLD_PCT = 25
const MIN_DELTA_USD = 50
const PRIOR_PERIODS = 3

// M7.3: category spending now comes from the classifier, so a month whose
// "spending" was a card payment or a transfer no longer looks like a spike. This
// is the detector behind plan §7's "$313" alert.
export const detectOverspending: Detector = (ctx) => {
  const period = currentPeriod(ctx)
  const priors = priorPeriods(ctx, PRIOR_PERIODS)

  const spendIn = (key: string) =>
    spendByBucket(ctx.classified, key, ctx.startDay, ctx.paymentAppByPeriod, PAYMENTS_TO_PEOPLE)

  // A period with no rows at all is not a $0 period, it is absent — averaging it
  // in would halve the baseline and fire on nothing.
  const priorWithData = priors.filter((p) =>
    ctx.classified.some((r) => r.date >= new Date(`${p.start}T00:00:00.000Z`) && r.date < new Date(`${p.end}T00:00:00.000Z`)),
  )
  if (priorWithData.length === 0) return []

  const priorSpend = priorWithData.map((p) => spendIn(p.key))
  const current = spendIn(period.key)

  const out = []
  for (const cat of Object.keys(current)) {
    if (current[cat] <= 0) continue
    const avg = priorSpend.reduce((s, m) => s + (m[cat] ?? 0), 0) / priorWithData.length
    if (avg < 50) continue
    const delta = current[cat] - avg
    const pct = (delta / avg) * 100
    if (pct < THRESHOLD_PCT || delta < MIN_DELTA_USD) continue

    out.push({
      kind: "overspending" as const,
      fingerprint: `spending_vs_avg:${cat}:${period.key}`,
      severity: "high" as const,
      title: `${cat} is ${pct.toFixed(0)}% above your ${priorWithData.length}-period average`,
      body: `You've spent $${current[cat].toFixed(0)} in ${cat} this ${
        ctx.startDay === 1 ? "month" : "period"
      } vs an average of $${avg.toFixed(0)}.`,
      data: { category: cat, currentAmount: current[cat], averageAmount: avg, pctOver: pct },
    })
  }
  return out
}
