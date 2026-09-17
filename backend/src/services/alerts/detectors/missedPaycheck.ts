import type { Detector } from "../types"

const GRACE_DAYS = 3

// M7.3: "did a deposit arrive?" now means a row the classifier calls income.
// Before, any negative amount counted — so a friend repaying you through Venmo,
// or money moved in from your own savings, could satisfy a missing paycheck and
// suppress the alert.
export const detectMissedPaycheck: Detector = (ctx) => {
  const { subscriptionAnalysis, classified, now } = ctx
  if (!subscriptionAnalysis) return []

  // Plaid recurring API: inflow_streams are income streams
  const incomeStreams: any[] = (subscriptionAnalysis as any).incomeStreams ?? []
  const out = []

  for (const stream of incomeStreams) {
    const predictedRaw = stream.predictedNextDate ?? stream.predicted_next_date
    if (!predictedRaw) continue

    const predicted = new Date(predictedRaw)
    const daysSince = (now.getTime() - predicted.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < GRACE_DAYS) continue  // still within grace period

    // Check if we actually received a matching deposit near the expected date
    const windowStart = new Date(predicted); windowStart.setDate(predicted.getDate() - 3)
    const windowEnd   = new Date(predicted); windowEnd.setDate(predicted.getDate() + GRACE_DAYS)
    const merchantKey = (stream.merchantName ?? stream.merchant_name ?? "").toLowerCase()

    const received = classified.some(row =>
      row.verdict.kind === "income" &&
      row.date >= windowStart &&
      row.date <= windowEnd &&
      (merchantKey === "" || row.merchantLabel.toLowerCase().includes(merchantKey))
    )
    if (received) continue

    // UTC, like every other date key in the app.
    const ym = predicted.toISOString().slice(0, 7)
    const displayName = stream.merchantName ?? stream.merchant_name ?? "Paycheck"

    out.push({
      kind: "missed_paycheck" as const,
      fingerprint: `missed_paycheck:${ym}`,
      severity: "medium" as const,
      title: `${displayName} is ${Math.floor(daysSince)} days late`,
      body: `Expected on ${predicted.toISOString().slice(0, 10)}, but no matching deposit has arrived yet.`,
      data: {
        merchantName: displayName,
        predictedDate: predicted.toISOString().slice(0, 10),
        daysSince: Math.floor(daysSince),
      },
    })
  }

  return out
}