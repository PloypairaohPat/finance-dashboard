import type { Detector } from "../types"
import { currentPeriod, priorPeriods } from "../types"
import { incomeForPeriod, savingsRateFor, spendForPeriod } from "../../classification.service"

const MILESTONE_RATE = 30
const PRIOR_PERIODS = 3

// M7.3: every figure here comes from the classifier. The savings-rate milestone
// also respects the same floor as the Monthly summary, so a period with almost
// no income can no longer produce a celebratory "you saved 97%".
export const detectPositiveMilestones: Detector = (ctx) => {
  const { accounts } = ctx
  const period = currentPeriod(ctx)
  const priors = priorPeriods(ctx, PRIOR_PERIODS)
  const out = []

  const spendIn = (key: string) => spendForPeriod(ctx.classified, key, ctx.startDay, ctx.paymentAppByPeriod)
  const incomeIn = (key: string) => incomeForPeriod(ctx.classified, key, ctx.startDay)

  const monthSpent = spendIn(period.key)
  const monthIncome = incomeIn(period.key)
  const priorIncomes = priors.map((p) => incomeIn(p.key))
  const noun = ctx.startDay === 1 ? "month" : "period"

  // ── 1. Savings rate ≥ 30% this period ───────────────────────────────────
  const { rate } = savingsRateFor(monthIncome, monthIncome - monthSpent, priorIncomes)
  if (rate !== null && rate >= MILESTONE_RATE) {
    const priorHighCount = priors.filter((p) => {
      const pIncome = incomeIn(p.key)
      const pRate = savingsRateFor(pIncome, pIncome - spendIn(p.key), priorIncomes).rate
      return pRate !== null && pRate >= MILESTONE_RATE
    }).length

    if (priorHighCount === 0) {
      out.push({
        kind: "positive_milestone" as const,
        fingerprint: `milestone:savings_rate_high:${period.key}`,
        severity: "positive" as const,
        title: `You saved ${rate.toFixed(0)}% of your income this ${noun}`,
        body: `That's above the 30% milestone and your best savings rate in the past 3 ${noun}s. Keep it up!`,
        data: { savingsRate: rate, monthSpent, monthIncome },
      })
    }
  }

  // ── 2. Spending down >10% against the previous period ───────────────────
  const previous = priors[priors.length - 1]
  const prevSpent = previous ? spendIn(previous.key) : 0
  if (prevSpent > 100 && monthSpent > 0) {
    const dropPct = ((prevSpent - monthSpent) / prevSpent) * 100
    if (dropPct >= 10) {
      out.push({
        kind: "positive_milestone" as const,
        fingerprint: `milestone:spending_down_mom:${period.key}`,
        severity: "positive" as const,
        title: `Spending is down ${dropPct.toFixed(0)}% from last ${noun}`,
        body: `You've spent $${monthSpent.toFixed(0)} so far this ${noun} vs $${prevSpent.toFixed(0)} last ${noun}. Nice discipline.`,
        data: { currentSpent: monthSpent, prevSpent, dropPct: Number(dropPct.toFixed(1)) },
      })
    }
  }

  // ── 3. Runway ≥ 6 periods ───────────────────────────────────────────────
  const totalLiquid = accounts
    .filter((a) => a.type === "depository")
    .reduce((s, a) => s + Number(a.currentBalance ?? a.availableBalance ?? 0), 0)
  const avgMonthlySpend = prevSpent > 0 ? (monthSpent + prevSpent) / 2 : monthSpent
  if (avgMonthlySpend > 0) {
    const runwayMonths = totalLiquid / avgMonthlySpend
    if (runwayMonths >= 6) {
      out.push({
        kind: "positive_milestone" as const,
        fingerprint: `milestone:runway_6mo:${period.key}`,
        severity: "positive" as const,
        title: `You have ${runwayMonths.toFixed(1)} ${noun}s of runway`,
        body: `With $${totalLiquid.toFixed(0)} liquid and ~$${avgMonthlySpend.toFixed(0)}/${noun} in expenses, you're above the 6-${noun} safety net target.`,
        data: { totalLiquid, avgMonthlySpend, runwayMonths: Number(runwayMonths.toFixed(1)) },
      })
    }
  }

  return out
}
