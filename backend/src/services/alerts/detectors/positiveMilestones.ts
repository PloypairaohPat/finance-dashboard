import type { Detector } from "../types"
import { isSpending } from "../../../lib/categoryMap"

export const detectPositiveMilestones: Detector = (ctx) => {
  const { transactions, accounts, now } = ctx
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const out = []

  // ── 1. Savings rate ≥ 30% this month ────────────────────────────────────
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
  let monthSpent = 0, monthIncome = 0
  for (const tx of transactions) {
    const amt = Number(tx.amount)
    if (tx.date < monthStart) continue
    if (amt > 0 && isSpending(tx.categoryPrimary)) monthSpent += amt
    else if (amt < 0) monthIncome += Math.abs(amt)
  }

  if (monthIncome > 0) {
    const savingsRate = ((monthIncome - monthSpent) / monthIncome) * 100
    if (savingsRate >= 30) {
      let priorHighCount = 0
      for (let i = 1; i <= 3; i++) {
        const pStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1))
        const pEnd   = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i + 1, 1))
        let ps = 0, pi = 0
        for (const tx of transactions) {
          const amt = Number(tx.amount)
          if (tx.date < pStart || tx.date >= pEnd) continue
          if (amt > 0 && isSpending(tx.categoryPrimary)) ps += amt
          else if (amt < 0) pi += Math.abs(amt)
        }
        if (pi > 0 && ((pi - ps) / pi) * 100 >= 30) priorHighCount++
      }
      if (priorHighCount === 0) {
        out.push({
          kind: "positive_milestone" as const,
          fingerprint: `milestone:savings_rate_high:${ym}`,
          severity: "positive" as const,
          title: `You saved ${savingsRate.toFixed(0)}% of your income this month`,
          body: `That's above the 30% milestone and your best savings rate in the past 3 months. Keep it up!`,
          data: { savingsRate: Number(savingsRate.toFixed(1)), monthSpent, monthIncome },
        })
      }
    }
  }

  // ── 2. Spending down >10% month-over-month ───────────────────────────────
  const prevMonthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  const prevMonthEnd   = new Date(monthStart)
  let prevSpent = 0
  for (const tx of transactions) {
    const amt = Number(tx.amount)
    if (tx.date < prevMonthStart || tx.date >= prevMonthEnd) continue
    if (amt > 0 && isSpending(tx.categoryPrimary)) prevSpent += amt
  }
  if (prevSpent > 100 && monthSpent > 0) {
    const dropPct = ((prevSpent - monthSpent) / prevSpent) * 100
    if (dropPct >= 10) {
      out.push({
        kind: "positive_milestone" as const,
        fingerprint: `milestone:spending_down_mom:${ym}`,
        severity: "positive" as const,
        title: `Spending is down ${dropPct.toFixed(0)}% from last month`,
        body: `You've spent $${monthSpent.toFixed(0)} so far this month vs $${prevSpent.toFixed(0)} last month. Nice discipline.`,
        data: { currentSpent: monthSpent, prevSpent, dropPct: Number(dropPct.toFixed(1)) },
      })
    }
  }

  // ── 3. Runway ≥ 6 months ─────────────────────────────────────────────────
  const totalLiquid = accounts
    .filter(a => a.type === "depository")
    .reduce((s, a) => s + Number(a.currentBalance ?? a.availableBalance ?? 0), 0)
  const avgMonthlySpend = prevSpent > 0 ? (monthSpent + prevSpent) / 2 : monthSpent
  if (avgMonthlySpend > 0) {
    const runwayMonths = totalLiquid / avgMonthlySpend
    if (runwayMonths >= 6) {
      out.push({
        kind: "positive_milestone" as const,
        fingerprint: `milestone:runway_6mo:${ym}`,
        severity: "positive" as const,
        title: `You have ${runwayMonths.toFixed(1)} months of runway`,
        body: `With $${totalLiquid.toFixed(0)} liquid and ~$${avgMonthlySpend.toFixed(0)}/mo in expenses, you're above the 6-month safety net target.`,
        data: { totalLiquid, avgMonthlySpend, runwayMonths: Number(runwayMonths.toFixed(1)) },
      })
    }
  }

  return out
}