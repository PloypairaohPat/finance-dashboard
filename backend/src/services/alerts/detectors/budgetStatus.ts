import type { Detector, DetectedAlert } from "../types"
import { mapPlaidCategory, isSpending } from "../../../lib/categoryMap"

function computeSpent(ctx: Parameters<Detector>[0], category: string, ym: string): number {
  const [y, m] = ym.split("-").map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  let sum = 0
  for (const tx of ctx.transactions) {
    const amt = Number(tx.amount)
    if (amt <= 0 || !isSpending(tx.categoryPrimary)) continue
    if (tx.date < start || tx.date >= end) continue
    if (mapPlaidCategory(tx.categoryPrimary) !== category) continue
    sum += amt
  }
  return sum
}

export const detectBudgetExceeded: Detector = (ctx) => {
  const out: DetectedAlert[] = []
  const ym = `${ctx.now.getFullYear()}-${String(ctx.now.getMonth() + 1).padStart(2, "0")}`

  for (const b of ctx.budgets) {
    const spent = computeSpent(ctx, b.category, b.month)
    const amount = Number(b.monthlyLimit)
    if (spent < amount) continue

    const over = spent - amount
    out.push({
      kind: "budget_exceeded" as const,
      fingerprint: `budget_exceeded:${b.category}:${b.month}`,
      severity: "high" as const,
      title: `${b.category} budget exceeded`,
      body: `You've spent $${spent.toFixed(0)} against a $${amount.toFixed(0)} budget — over by $${over.toFixed(0)}.`,
      data: { category: b.category, month: b.month, spent, amount, over },
    })
  }
  return out
}

export const detectBudgetProjectedOver: Detector = (ctx) => {
  const out: DetectedAlert[] = []
  const day = ctx.now.getDate()
  if (day < 7) return out

  const daysInMonth = new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 0).getDate()
  const ym = `${ctx.now.getFullYear()}-${String(ctx.now.getMonth() + 1).padStart(2, "0")}`

  for (const b of ctx.budgets) {
    if (b.month !== ym) continue
    const spent = computeSpent(ctx, b.category, b.month)
    const amount = Number(b.monthlyLimit)
    if (spent >= amount) continue
    const projected = (spent / day) * daysInMonth
    if (projected <= amount) continue

    const projectedOver = projected - amount
    out.push({
      kind: "budget_projected_over" as const,
      fingerprint: `budget_proj:${b.category}:${b.month}`,
      severity: "medium" as const,
      title: `${b.category} pacing over budget`,
      body: `At your current pace you'll hit $${projected.toFixed(0)} by month-end — $${projectedOver.toFixed(0)} over the $${amount.toFixed(0)} budget.`,
      data: { category: b.category, month: b.month, spent, amount, projected, projectedOver },
    })
  }
  return out
}