import prisma from "../lib/prisma"
import { mapPlaidCategory, CATEGORY_COLORS } from "../lib/categoryMap"
import { PAYMENTS_TO_PEOPLE } from "../lib/classifier"
import {
  classifyWindow,
  incomeForPeriod,
  savingsRateFor,
  spendByBucket,
  spendForPeriod,
} from "./classification.service"
import {
  DEFAULT_PERIOD_START_DAY,
  fromDateKey,
  periodKeyOf,
  recentPeriods,
  type Period,
} from "../lib/period"

export type Sentiment = "positive" | "negative" | "neutral"
export interface Insight {
  type: string
  headline: string
  sentiment: Sentiment
}

export interface InsightsResponse {
  summary: {
    month: string                  // period key (YYYY-MM-DD start date)
    monthLabel: string             // "April" for start day 1, else "Apr 10 – May 9"
    income: number
    expenses: number
    netSaved: number
    savingsRate: number | null     // % — null when income is under the floor
    /** The income this period had to clear for a rate to be shown at all. */
    savingsRateFloor: number
    /** True when a rate exists arithmetically but is too unreliable to show. */
    savingsRateSuppressed: boolean
    /** The period these figures cover, including whether it's still in progress. */
    period: Period
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

const round2 = (n: number) => Math.round(n * 100) / 100

// How many periods to classify at once: the current one, plus enough completed
// periods to compute the savings-rate floor from the last three with income.
const LOOKBACK_PERIODS = 5

export async function fetchInsights(
  userId: string,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
): Promise<InsightsResponse> {
  const periods = recentPeriods(now, startDay, LOOKBACK_PERIODS)
  const thisPeriod = periods[periods.length - 1]
  const lastPeriod = periods[periods.length - 2]

  const [{ rows, paymentAppByPeriod }, rawAccounts] = await Promise.all([
    classifyWindow(userId, {
      since: fromDateKey(periods[0].start),
      until: fromDateKey(thisPeriod.end),
      startDay,
    }),
    prisma.account.findMany({ where: { userId }, select: { type: true, currentBalance: true } }),
  ])

  const income = incomeForPeriod(rows, thisPeriod.key, startDay)
  const expenses = spendForPeriod(rows, thisPeriod.key, startDay, paymentAppByPeriod)
  const netSaved = round2(income - expenses)

  // The floor uses the same income definition as the figure it guards.
  const completedIncomes = periods
    .slice(0, -1)
    .map((p) => incomeForPeriod(rows, p.key, startDay))
  const { rate: savingsRate, floor, suppressed } = savingsRateFor(income, netSaved, completedIncomes)

  const cashAvailable = rawAccounts
    .filter((a) => a.type === "depository")
    .reduce((s, a) => s + (a.currentBalance ? Number(a.currentBalance) : 0), 0)

  // Runway averages the periods that actually have data, as before.
  const periodsWithRows = periods.filter((p) =>
    rows.some((r) => periodKeyOf(r.date, startDay) === p.key),
  )
  const monthsOfHistory = periodsWithRows.length
  const avgMonthlyExpenses = monthsOfHistory > 0
    ? round2(
        periodsWithRows.reduce(
          (s, p) => s + spendForPeriod(rows, p.key, startDay, paymentAppByPeriod),
          0,
        ) / monthsOfHistory,
      )
    : 0
  const runwayMonths = avgMonthlyExpenses > 0 && monthsOfHistory >= 1
    ? Number((cashAvailable / avgMonthlyExpenses).toFixed(1))
    : null

  // Merchant views cover ordinary spending only: a payment to a person is not
  // a merchant, and its period total is capped rather than row by row.
  const thisPeriodSpend = rows.filter(
    (r) =>
      periodKeyOf(r.date, startDay) === thisPeriod.key &&
      r.verdict.kind === "spend" &&
      r.verdict.rule !== 4,
  )

  const merchantMap = new Map<string, { total: number; count: number }>()
  for (const r of thisPeriodSpend) {
    const m = merchantMap.get(r.merchantLabel) ?? { total: 0, count: 0 }
    m.total += r.amount
    m.count += 1
    merchantMap.set(r.merchantLabel, m)
  }
  const topMerchants = [...merchantMap.entries()]
    .map(([merchant, v]) => ({ merchant, total: round2(v.total), count: v.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  const largestPurchases = [...thisPeriodSpend]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((r) => {
      const display = r.verdict.bucket ?? mapPlaidCategory(r.categoryPrimary)
      return {
        id: r.id,
        merchant: r.merchantLabel,
        amount: round2(r.amount),
        date: r.date.toISOString().slice(0, 10),
        category: display,
        color: CATEGORY_COLORS[display as keyof typeof CATEGORY_COLORS] ?? "#5a7a5a",
      }
    })

  const highlights = generateHighlights({
    thisCats: spendByBucket(rows, thisPeriod.key, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE),
    lastCats: spendByBucket(rows, lastPeriod.key, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE),
    lastTotal: spendForPeriod(rows, lastPeriod.key, startDay, paymentAppByPeriod),
    hasLastPeriod: rows.some((r) => periodKeyOf(r.date, startDay) === lastPeriod.key),
    income,
    expenses,
    runwayMonths,
    monthsOfHistory,
    periodNoun: startDay === 1 ? "month" : "period",
    inProgress: thisPeriod.inProgress,
  })

  return {
    summary: {
      month: thisPeriod.key,
      monthLabel: thisPeriod.longLabel,
      income: round2(income),
      expenses: round2(expenses),
      netSaved,
      savingsRate,
      savingsRateFloor: floor,
      savingsRateSuppressed: suppressed,
      period: thisPeriod,
    },
    topMerchants,
    largestPurchases,
    runway: {
      months: runwayMonths,
      cashAvailable: round2(cashAvailable),
      avgMonthlyExpenses,
      monthsOfHistory,
    },
    highlights,
  }
}

// — — — Highlights generator — — —

interface HighlightInput {
  /** Spend by display bucket, this period and last. */
  thisCats: Record<string, number>
  lastCats: Record<string, number>
  lastTotal: number
  hasLastPeriod: boolean
  income: number
  expenses: number
  runwayMonths: number | null
  monthsOfHistory: number
  /** "month" for start day 1, otherwise "period". */
  periodNoun: "month" | "period"
  /** The current period isn't over; comparisons say "so far" rather than projecting. */
  inProgress: boolean
}

function generateHighlights(i: HighlightInput): Insight[] {
  const out: Insight[] = []
  const noun = i.periodNoun
  // A partial period compared with a full one reads as "spending is down" —
  // say it's partial instead of letting the comparison flatter.
  const soFar = i.inProgress ? " so far" : ""

  // 1. Total spend delta vs last period
  if (i.hasLastPeriod && i.lastTotal > 0) {
    const pct = ((i.expenses - i.lastTotal) / i.lastTotal) * 100
    const sign = pct >= 0 ? "up" : "down"
    out.push({
      type: "total_spend_delta",
      headline: `Spending${soFar} is ${sign} ${Math.abs(pct).toFixed(0)}% vs last ${noun} ($${i.expenses.toFixed(0)}${soFar} vs $${i.lastTotal.toFixed(0)}).`,
      sentiment: pct >= 5 ? "negative" : pct <= -5 ? "positive" : "neutral",
    })
  }

  // 2. Biggest category mover
  if (i.hasLastPeriod) {
    let biggest: { cat: string; pct: number; abs: number } | null = null
    for (const cat of Object.keys(i.thisCats)) {
      const prev = i.lastCats[cat] ?? 0
      if (prev === 0) continue
      const pct = ((i.thisCats[cat] - prev) / prev) * 100
      const abs = Math.abs(pct)
      if (!biggest || abs > biggest.abs) biggest = { cat, pct, abs }
    }
    if (biggest && biggest.abs >= 15) {
      const sign = biggest.pct >= 0 ? "+" : ""
      out.push({
        type: "category_mover",
        headline: `${biggest.cat} is your biggest mover${soFar} at ${sign}${biggest.pct.toFixed(0)}%.`,
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
        headline: `Saving ${rate.toFixed(0)}% of income this ${noun}${soFar} — strong rate.`,
        sentiment: "positive",
      })
    } else if (rate < 0) {
      out.push({
        type: "savings_negative",
        headline: `Spending more than earning this ${noun}${soFar} — ${Math.abs(rate).toFixed(0)}% over.`,
        sentiment: "negative",
      })
    }
  }

  return out
    .sort((a, b) => (a.sentiment === "neutral" ? 1 : 0) - (b.sentiment === "neutral" ? 1 : 0))
    .slice(0, 3)
}
