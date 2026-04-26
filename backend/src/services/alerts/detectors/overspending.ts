import type { Detector } from "../types"
import { mapPlaidCategory, isSpending } from "../../../lib/categoryMap"

const THRESHOLD_PCT = 25
const MIN_DELTA_USD = 50

export const detectOverspending: Detector = (ctx) => {
  const { transactions, now } = ctx
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const monthSpend: Record<string, Record<string, number>> = {}
  for (const tx of transactions) {
    const amt = Number(tx.amount)
    if (amt <= 0 || !isSpending(tx.categoryPrimary)) continue
    const txYm = `${tx.date.getFullYear()}-${String(tx.date.getMonth() + 1).padStart(2, "0")}`
    const cat = mapPlaidCategory(tx.categoryPrimary)
    monthSpend[txYm] ??= {}
    monthSpend[txYm][cat] = (monthSpend[txYm][cat] ?? 0) + amt
  }

  const priorMonths: string[] = []
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    priorMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`)
  }
  const priorCount = priorMonths.filter(m => monthSpend[m]).length
  if (priorCount === 0) return []

  const out = []
  const current = monthSpend[ym] ?? {}
  for (const cat of Object.keys(current)) {
    const avg = priorMonths.reduce((s, m) => s + (monthSpend[m]?.[cat] ?? 0), 0) / priorCount
    if (avg < 50) continue
    const delta = current[cat] - avg
    const pct = (delta / avg) * 100
    if (pct < THRESHOLD_PCT || delta < MIN_DELTA_USD) continue

    out.push({
      kind: "overspending" as const,
      fingerprint: `spending_vs_avg:${cat}:${ym}`,
      severity: "high" as const,
      title: `${cat} is ${pct.toFixed(0)}% above your 3-month average`,
      body: `You've spent $${current[cat].toFixed(0)} in ${cat} this month vs an average of $${avg.toFixed(0)}.`,
      data: { category: cat, currentAmount: current[cat], averageAmount: avg, pctOver: pct },
    })
  }
  return out
}