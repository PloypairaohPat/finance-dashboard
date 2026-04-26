import type { Detector } from "../types"

export const detectSubscriptionPriceUp: Detector = (ctx) => {
  const { subscriptionAnalysis, now } = ctx
  if (!subscriptionAnalysis) return []

  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const subscriptions: any[] = (subscriptionAnalysis as any).subscriptions ?? []
  const out = []

  for (const sub of subscriptions) {
    const priceChange = sub.priceChange ?? sub.price_change ?? 0
    if (priceChange <= 0) continue

    const lastAmount     = sub.lastAmount ?? sub.last_amount ?? 0
    const previousAmount = sub.previousAmount ?? sub.previous_amount ?? 0
    const merchantName   = sub.merchantName ?? sub.merchant_name ?? "Unknown subscription"

    if (previousAmount <= 0) continue
    const pct = ((lastAmount - previousAmount) / previousAmount) * 100

    out.push({
      kind: "subscription_price_up" as const,
      fingerprint: `price_up:${merchantName}:${ym}`,
      severity: pct > 25 ? "high" as const : "medium" as const,
      title: `${merchantName} raised its price`,
      body: `Charged $${lastAmount.toFixed(2)} — up from $${previousAmount.toFixed(2)} last cycle (+${pct.toFixed(0)}%).`,
      data: { merchantName, lastAmount, previousAmount, pctChange: pct },
    })
  }

  return out
}