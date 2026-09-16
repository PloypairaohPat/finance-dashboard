import prisma from "../lib/prisma"
import { PAYMENTS_TO_PEOPLE } from "../lib/classifier"
import { fromDateKey, recentPeriods, type Period } from "../lib/period"
import {
  classifyWindow,
  incomeForPeriod,
  spendByBucket,
  spendForPeriod,
  type ClassifiedRow,
} from "./classification.service"
import { getPeriodStartDay } from "./user.service"

// The score used to run on its own definitions: every negative amount was
// income, spending was isSpending, and internal transfers were removed by the
// old two-tier heuristic — which calibration showed misses most transfer pairs.
// It is a single authoritative number out of 100, which makes it the worst place
// in the app to be wrong, so it now reads the same figures the screens show.
const SCORE_PERIODS = 4   // the current period plus three completed ones

interface ScoreWindow {
  startDay: number
  periods: Period[]
  rows: ClassifiedRow[]
  paymentAppByPeriod: Map<string, number>
  /** Periods that actually contain rows, oldest first. */
  withData: Period[]
}

async function loadScoreWindow(userId: string): Promise<ScoreWindow> {
  const startDay = await getPeriodStartDay(userId)
  const periods = recentPeriods(new Date(), startDay, SCORE_PERIODS)
  const { rows, paymentAppByPeriod } = await classifyWindow(userId, {
    since: fromDateKey(periods[0].start),
    until: fromDateKey(periods[periods.length - 1].end),
    startDay,
  })
  const withData = periods.filter((p) =>
    rows.some((r) => r.date >= fromDateKey(p.start) && r.date < fromDateKey(p.end)),
  )
  return { startDay, periods, rows, paymentAppByPeriod, withData }
}

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

function scoreSavingsRate(w: ScoreWindow): ScoreComponent {
  const weight = WEIGHTS.savingsRate

  let income = 0, expenses = 0
  for (const p of w.withData) {
    income += incomeForPeriod(w.rows, p.key, w.startDay)
    expenses += spendForPeriod(w.rows, p.key, w.startDay, w.paymentAppByPeriod)
  }
  const monthsCovered = w.withData.length

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

async function scoreSpendingControl(userId: string, w: ScoreWindow): Promise<ScoreComponent> {
  const weight = WEIGHTS.spendingControl
  const budgets = await prisma.budget.findMany({ where: { userId } })

  if (budgets.length === 0) {
    return {
      value: 70, weight,
      hint: "No budgets set — set a few to get a real score here.",
      dataLimited: true,
    }
  }

  // The same figure the budget cards and the budget alerts use: current money
  // period, classifier buckets, payment-app total capped.
  const current = w.periods[w.periods.length - 1]
  const spendByCat = spendByBucket(w.rows, current.key, w.startDay, w.paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
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

async function scoreDebtLoad(userId: string, w: ScoreWindow): Promise<ScoreComponent> {
  const weight = WEIGHTS.debtLoad
  const accounts = await prisma.account.findMany({ where: { userId } })

  const totalDebt = accounts
    .filter(a => a.type === "credit" || a.type === "loan")
    .reduce((s, a) => s + Math.abs(Number(a.currentBalance ?? 0)), 0)

  // Income, not "every negative amount". This component divides debt by it, so
  // counting repayments from friends and money moved in from savings as income
  // made the debt load look lighter than it is.
  const periodsWithIncome = w.withData.filter((p) => incomeForPeriod(w.rows, p.key, w.startDay) > 0)
  const totalIncome = periodsWithIncome.reduce(
    (s, p) => s + incomeForPeriod(w.rows, p.key, w.startDay), 0,
  )
  const monthsCovered = periodsWithIncome.length

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

  // Use stored accountType from each snapshot row — identical logic to fetchNetWorthHistory.
  // Looking up type from the Account table would silently mis-classify snapshots for
  // accounts that were deleted/re-linked (orphaned rows whose plaidAccountId no longer
  // exists in the Account table would return undefined and get treated as assets).
  const snapshots = await prisma.balanceSnapshot.findMany({
    where: { userId, date: { gte: ninetyAgo } },
    select: { date: true, currentBalance: true, accountType: true },
    orderBy: { date: "asc" },
  })

  // Group by date, compute daily net worth (same formula as the chart)
  const byDate = new Map<string, number>()
  for (const s of snapshots) {
    const key = s.date.toISOString().slice(0, 10)
    let nw = byDate.get(key) ?? 0
    const bal = Number(s.currentBalance ?? 0)
    if (s.accountType === "credit" || s.accountType === "loan") nw -= Math.abs(bal)
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
  // One classification for the three components that read transactions; the
  // fourth reads balance snapshots and is unaffected by any of this.
  const window = await loadScoreWindow(userId)
  const [spendingControl, debtLoad, growthTrend] = await Promise.all([
    scoreSpendingControl(userId, window),
    scoreDebtLoad(userId, window),
    scoreGrowthTrend(userId),
  ])
  const savingsRate = scoreSavingsRate(window)
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