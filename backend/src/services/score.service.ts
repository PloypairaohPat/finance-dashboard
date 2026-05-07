import prisma from "../lib/prisma"
import { isSpending, mapPlaidCategory } from "../lib/categoryMap"

const WEIGHTS = {
  savingsRate:     0.30,
  spendingControl: 0.25,
  debtLoad:        0.25,
  growthTrend:     0.20,
} as const

export type ComponentKey = keyof typeof WEIGHTS

export interface ScoreComponent {
  value: number | null      // 0-100 or null if not enough data
  weight: number            // 0-1
  hint: string              // human-readable
  dataLimited: boolean
}

export interface FinancialScore {
  total: number             // weighted avg of non-null components, rescaled to 0-100
  grade: "excellent" | "good" | "fair" | "needs_work" | "at_risk"
  components: Record<ComponentKey, ScoreComponent>
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

const gradeFor = (total: number): FinancialScore["grade"] =>
  total >= 85 ? "excellent"
  : total >= 70 ? "good"
  : total >= 55 ? "fair"
  : total >= 40 ? "needs_work"
  : "at_risk"

// — — — Component scorers — — —

async function scoreSavingsRate(userId: string): Promise<ScoreComponent> {
  const weight = WEIGHTS.savingsRate
  const ninetyAgo = new Date(); ninetyAgo.setDate(ninetyAgo.getDate() - 90)
  const txs = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, date: { gte: ninetyAgo } },
    select: { amount: true, categoryPrimary: true, date: true },
  })

  let income = 0, expenses = 0
  for (const tx of txs) {
    const amt = Number(tx.amount)
    if (amt < 0) income += Math.abs(amt)
    else if (isSpending(tx.categoryPrimary)) expenses += amt
  }
  const monthsCovered = new Set(txs.map(t =>
    `${t.date.getFullYear()}-${t.date.getMonth() + 1}`
  )).size

  if (monthsCovered < 1 || income < 100) {
    return { value: null, weight, hint: "Need more income history to score.", dataLimited: true }
  }
  const saved = income - expenses
  const rate = (saved / income) * 100
  const value = clamp((rate / 30) * 100)
  const hint = rate >= 30 ? "Saving >30% of income."
    : rate >= 15 ? "Saving modestly; room to grow."
    : rate >= 0  ? "Slim savings rate — target 20%+."
    : "Spending more than you earn."
  return { value: Number(value.toFixed(0)), weight, hint, dataLimited: monthsCovered < 3 }
}

async function scoreSpendingControl(userId: string): Promise<ScoreComponent> {
  const weight = WEIGHTS.spendingControl
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const [budgets, txs] = await Promise.all([
    prisma.budget.findMany({ where: { userId } }),
    prisma.transaction.findMany({
      where: {
        userId, deletedAt: null,
        amount: { gt: 0 },
        date: {
          gte: new Date(`${ym}-01T00:00:00Z`),
          lt: new Date(new Date(`${ym}-01T00:00:00Z`).setUTCMonth(now.getUTCMonth() + 1)),
        },
      },
      select: { amount: true, categoryPrimary: true },
    }),
  ])

  if (budgets.length === 0) {
    return {
      value: 70, weight,
      hint: "No budgets set — set a few to get a real score here.",
      dataLimited: true,
    }
  }

  // Sum spending per display category (same math as budget detectors)
  const spendByCat: Record<string, number> = {}
  for (const tx of txs) {
    if (!isSpending(tx.categoryPrimary)) continue
    const cat = mapPlaidCategory(tx.categoryPrimary)
    spendByCat[cat] = (spendByCat[cat] ?? 0) + Number(tx.amount)
  }
  let onTrack = 0
  for (const b of budgets) {
    const spent = spendByCat[b.category] ?? 0
    if (spent <= Number(b.monthlyLimit) * 0.95) onTrack++
  }
  const value = Math.round((onTrack / budgets.length) * 100)
  const hint = value >= 90 ? "All budgets on track."
    : value >= 70 ? "Most budgets on track."
    : value >= 40 ? "Several budgets under pressure."
    : "Majority of budgets exceeded."
  return { value, weight, hint, dataLimited: false }
}

async function scoreDebtLoad(userId: string): Promise<ScoreComponent> {
  const weight = WEIGHTS.debtLoad
  const ninetyAgo = new Date(); ninetyAgo.setDate(ninetyAgo.getDate() - 90)

  const [accounts, incomeTxs] = await Promise.all([
    prisma.account.findMany({ where: { userId } }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, amount: { lt: 0 }, date: { gte: ninetyAgo } },
      select: { amount: true, date: true },
    }),
  ])

  const totalDebt = accounts
    .filter(a => a.type === "credit" || a.type === "loan")
    .reduce((s, a) => s + Math.abs(Number(a.currentBalance ?? 0)), 0)

  const totalIncome = incomeTxs.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const monthsCovered = new Set(incomeTxs.map(t =>
    `${t.date.getFullYear()}-${t.date.getMonth() + 1}`
  )).size

  if (monthsCovered < 1 || totalIncome < 100) {
    return { value: null, weight, hint: "Need income history to compute debt ratio.", dataLimited: true }
  }
  const avgMonthlyIncome = totalIncome / monthsCovered
  const ratio = totalDebt / avgMonthlyIncome   // months of income to pay off all debt
  const value = clamp((1 - ratio / 3) * 100)   // 0 debt = 100; 3mo of income in debt = 0

  const hint = ratio < 0.5 ? "Debt load very low."
    : ratio < 1   ? "Manageable debt load."
    : ratio < 2   ? "Debt is notable — plan to pay down."
    : "Heavy debt relative to income."
  return { value: Number(value.toFixed(0)), weight, hint, dataLimited: monthsCovered < 3 }
}

async function scoreGrowthTrend(userId: string): Promise<ScoreComponent> {
  const weight = WEIGHTS.growthTrend
  const ninetyAgo = new Date(); ninetyAgo.setDate(ninetyAgo.getDate() - 90)

  // Fetch snapshots and account types separately to avoid include relation issues
  const [snapshots, accounts] = await Promise.all([
    prisma.balanceSnapshot.findMany({
      where: { userId, date: { gte: ninetyAgo } },
      select: { accountId: true, date: true, currentBalance: true },
      orderBy: { date: "asc" },
    }),
    prisma.account.findMany({
      where: { userId },
      select: { id: true, type: true },
    }),
  ])

  // Build a lookup map for account types
  const typeMap = Object.fromEntries(accounts.map(a => [a.id, a.type]))

  // Group by date, compute daily net worth
  const byDate = new Map<string, number>()
  for (const s of snapshots) {
    const key = s.date.toISOString().slice(0, 10)
    let nw = byDate.get(key) ?? 0
    const bal = Number(s.currentBalance ?? 0)
    const accountType = typeMap[s.accountId]
    if (accountType === "credit" || accountType === "loan") nw -= Math.abs(bal)
    else nw += bal
    byDate.set(key, nw)
  }
  const points = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, nw]) => nw)

  if (points.length < 14) {
    return { value: null, weight, hint: "Need 14+ days of snapshots for a trend.", dataLimited: true }
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (Math.abs(first) < 100) {
    // Net worth starts near 0 — percentage change meaningless; judge by sign of delta
    const delta = last - first
    const value = delta > 0 ? 75 : delta < 0 ? 25 : 50
    return { value, weight, hint: delta >= 0 ? "Net worth growing." : "Net worth declining.", dataLimited: true }
  }
  const pctChange = ((last - first) / Math.abs(first)) * 100
  // Linear: -10% = 0, 0% = 50, +10% = 100, clamped
  const value = clamp(50 + pctChange * 5)
  const hint = pctChange >= 5 ? `Net worth up ${pctChange.toFixed(1)}% over the window.`
    : pctChange >= -2 ? "Net worth roughly flat."
    : `Net worth down ${Math.abs(pctChange).toFixed(1)}% over the window.`
  return { value: Number(value.toFixed(0)), weight, hint, dataLimited: points.length < 60 }
}

// — — — Entry point — — —

export async function fetchFinancialScore(userId: string): Promise<FinancialScore> {
  const [savingsRate, spendingControl, debtLoad, growthTrend] = await Promise.all([
    scoreSavingsRate(userId),
    scoreSpendingControl(userId),
    scoreDebtLoad(userId),
    scoreGrowthTrend(userId),
  ])
  const components = { savingsRate, spendingControl, debtLoad, growthTrend }

  // Weighted average of non-null components, rescaled by total weight used
  let weighted = 0, usedWeight = 0
  for (const c of Object.values(components)) {
    if (c.value === null) continue
    weighted += c.value * c.weight
    usedWeight += c.weight
  }
  const total = usedWeight > 0 ? Math.round(weighted / usedWeight) : 0

  return { total, grade: gradeFor(total), components }
}