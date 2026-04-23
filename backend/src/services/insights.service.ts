import prisma from "../lib/prisma"
import { mapPlaidCategory, isSpending, CATEGORY_COLORS } from "../lib/categoryMap"

export type Sentiment = "positive" | "negative" | "neutral"
export interface Insight {
  type: string
  headline: string
  sentiment: Sentiment
}

export interface InsightsResponse {
  summary: {
    month: string                  // YYYY-MM
    monthLabel: string             // "April"
    income: number
    expenses: number
    netSaved: number
    savingsRate: number | null     // % or null if income == 0
  }
  topMerchants: Array<{ merchant: string; total: number; count: number }>
  largestPurchases: Array<{
    id: string; merchant: string; amount: number;
    date: string; category: string; color: string
  }>
  runway: {
    months: number | null          // null if not enough data
    cashAvailable: number
    avgMonthlyExpenses: number
    monthsOfHistory: number
  }
  highlights: Insight[]
}

const ymOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`

const monthBounds = (ym: string) => {
  const start = new Date(`${ym}-01T00:00:00Z`)
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1)
  return { start, end }
}

export async function fetchInsights(userId: string): Promise<InsightsResponse> {
  const now = new Date()
  const thisYM = ymOf(now)
  const lastYM = ymOf(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const monthLabel = now.toLocaleString("en-US", { month: "long" })

  const { start: thisStart, end: thisEnd } = monthBounds(thisYM)
  const { start: lastStart, end: lastEnd } = monthBounds(lastYM)

  // Pull this-month transactions (need full rows for merchants, largest, etc.)
  const thisMonthTxs = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, date: { gte: thisStart, lt: thisEnd } },
    select: {
      id: true, name: true, cleanName: true, amount: true,
      categoryPrimary: true, date: true,
    },
  })

  // Last-month txs only need amount + categoryPrimary for comparison
  const lastMonthTxs = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, date: { gte: lastStart, lt: lastEnd } },
    select: { amount: true, categoryPrimary: true },
  })

  // Cash available — depository balances
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { type: true, currentBalance: true },
  })
  const cashAvailable = accounts
    .filter(a => a.type === "depository")
    .reduce((s, a) => s + (a.currentBalance ? Number(a.currentBalance) : 0), 0)

  // Avg monthly expenses — last 90 days of expense data
  const ninetyAgo = new Date(now); ninetyAgo.setDate(ninetyAgo.getDate() - 90)
  const recentExpenses = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, amount: { gt: 0 }, date: { gte: ninetyAgo } },
    select: { amount: true, categoryPrimary: true, date: true },
  })
  const expenseSum = recentExpenses
    .filter(t => isSpending(t.categoryPrimary))
    .reduce((s, t) => s + t.amount.toNumber(), 0)
  // Number of distinct YYYY-MM in the recent window
  const monthsOfHistory = new Set(recentExpenses.map(t => ymOf(t.date))).size
  const avgMonthlyExpenses = monthsOfHistory > 0
    ? Number((expenseSum / monthsOfHistory).toFixed(2))
    : 0

  // Convert Decimal to number up front for all tx arrays
  const thisMonthNums = thisMonthTxs.map(tx => ({
    ...tx,
    amount: tx.amount.toNumber(),
  }))
  const lastMonthNums = lastMonthTxs.map(tx => ({
    ...tx,
    amount: tx.amount.toNumber(),
  }))

  // Monthly summary
  let income = 0, expenses = 0
  for (const tx of thisMonthNums) {
    if (tx.amount < 0) income += Math.abs(tx.amount)
    else if (isSpending(tx.categoryPrimary)) expenses += tx.amount
  }
  const netSaved = Number((income - expenses).toFixed(2))
  const savingsRate = income > 0
    ? Number(((netSaved / income) * 100).toFixed(1))
    : null

  // Top merchants — group by cleanName, fall back to name
  const merchantMap = new Map<string, { total: number; count: number }>()
  for (const tx of thisMonthNums) {
    if (tx.amount <= 0) continue
    if (!isSpending(tx.categoryPrimary)) continue
    const key = tx.cleanName ?? tx.name ?? "Unknown"
    const m = merchantMap.get(key) ?? { total: 0, count: 0 }
    m.total += tx.amount; m.count += 1
    merchantMap.set(key, m)
  }
  const topMerchants = [...merchantMap.entries()]
    .map(([merchant, v]) => ({
      merchant, total: Number(v.total.toFixed(2)), count: v.count,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  // Largest individual purchases this month
  const largestPurchases = thisMonthNums
    .filter(tx => tx.amount > 0 && isSpending(tx.categoryPrimary))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(tx => {
      const display = mapPlaidCategory(tx.categoryPrimary)
      return {
        id: tx.id,
        merchant: tx.cleanName ?? tx.name ?? "Unknown",
        amount: Number(tx.amount.toFixed(2)),
        date: tx.date.toISOString().slice(0, 10),
        category: display,
        color: CATEGORY_COLORS[display] ?? "#5a7a5a",
      }
    })

  // Cash runway — months until cash runs out at avg expense rate
  const runwayMonths = avgMonthlyExpenses > 0 && monthsOfHistory >= 1
    ? Number((cashAvailable / avgMonthlyExpenses).toFixed(1))
    : null

  // Highlights
  const highlights = generateHighlights({
    thisMonthTxs: thisMonthNums,
    lastMonthTxs: lastMonthNums,
    income, expenses,
    runwayMonths, monthsOfHistory,
  })

  return {
    summary: {
      month: thisYM, monthLabel,
      income: Number(income.toFixed(2)),
      expenses: Number(expenses.toFixed(2)),
      netSaved, savingsRate,
    },
    topMerchants,
    largestPurchases,
    runway: {
      months: runwayMonths,
      cashAvailable: Number(cashAvailable.toFixed(2)),
      avgMonthlyExpenses,
      monthsOfHistory,
    },
    highlights,
  }
}

// — — — Highlights generator — — —

interface HighlightInput {
  thisMonthTxs: Array<{ amount: number; categoryPrimary: string | null }>
  lastMonthTxs: Array<{ amount: number; categoryPrimary: string | null }>
  income: number
  expenses: number
  runwayMonths: number | null
  monthsOfHistory: number
}

function sumCategorySpend(txs: Array<{ amount: number; categoryPrimary: string | null }>) {
  const out: Record<string, number> = {}
  for (const tx of txs) {
    if (tx.amount <= 0 || !isSpending(tx.categoryPrimary)) continue
    const cat = mapPlaidCategory(tx.categoryPrimary)
    out[cat] = (out[cat] ?? 0) + tx.amount
  }
  return out
}

function generateHighlights(i: HighlightInput): Insight[] {
  const out: Insight[] = []

  const hasLastMonth = i.lastMonthTxs.length > 0

  // 1. Total spend delta vs last month
  if (hasLastMonth) {
    const lastTotal = i.lastMonthTxs
      .filter(t => t.amount > 0 && isSpending(t.categoryPrimary))
      .reduce((s, t) => s + t.amount, 0)
    if (lastTotal > 0) {
      const pct = ((i.expenses - lastTotal) / lastTotal) * 100
      const sign = pct >= 0 ? "up" : "down"
      out.push({
        type: "total_spend_delta",
        headline: `Spending is ${sign} ${Math.abs(pct).toFixed(0)}% vs last month ($${i.expenses.toFixed(0)} vs $${lastTotal.toFixed(0)}).`,
        sentiment: pct >= 5 ? "negative" : pct <= -5 ? "positive" : "neutral",
      })
    }
  }

  // 2. Biggest category mover
  if (hasLastMonth) {
    const thisCats = sumCategorySpend(i.thisMonthTxs)
    const lastCats = sumCategorySpend(i.lastMonthTxs)
    let biggest: { cat: string; pct: number; abs: number } | null = null
    for (const cat of Object.keys(thisCats)) {
      const prev = lastCats[cat] ?? 0
      if (prev === 0) continue
      const pct = ((thisCats[cat] - prev) / prev) * 100
      const abs = Math.abs(pct)
      if (!biggest || abs > biggest.abs) biggest = { cat, pct, abs }
    }
    if (biggest && biggest.abs >= 15) {
      const sign = biggest.pct >= 0 ? "+" : ""
      out.push({
        type: "category_mover",
        headline: `${biggest.cat} is your biggest mover at ${sign}${biggest.pct.toFixed(0)}%.`,
        sentiment: biggest.pct >= 0 ? "negative" : "positive",
      })
    }
  }

  // 3. Runway context
  if (i.runwayMonths !== null) {
    if (i.runwayMonths < 3) {
      out.push({
        type: "runway_low",
        headline: `Cash runway is ${i.runwayMonths} months — under 3 months of buffer.`,
        sentiment: "negative",
      })
    } else if (i.runwayMonths >= 12) {
      out.push({
        type: "runway_strong",
        headline: `${i.runwayMonths} months of cash runway — well above the 6-month rule of thumb.`,
        sentiment: "positive",
      })
    }
  }

  // 4. Savings rate callout
  if (i.income > 0) {
    const rate = (i.income - i.expenses) / i.income * 100
    if (rate >= 30) {
      out.push({
        type: "savings_strong",
        headline: `Saving ${rate.toFixed(0)}% of income this month — strong rate.`,
        sentiment: "positive",
      })
    } else if (rate < 0) {
      out.push({
        type: "savings_negative",
        headline: `Spending more than earning this month — ${Math.abs(rate).toFixed(0)}% over.`,
        sentiment: "negative",
      })
    }
  }

  return out
    .sort((a, b) => (a.sentiment === "neutral" ? 1 : 0) - (b.sentiment === "neutral" ? 1 : 0))
    .slice(0, 3)
}
