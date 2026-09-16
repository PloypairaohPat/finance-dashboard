import prisma from "../lib/prisma"
import {
  DEFAULT_PERIOD_START_DAY,
  fromDateKey,
  periodKeyOf,
  periodsFromFirstActivity,
  recentPeriods,
  type Period,
} from "../lib/period"
import { fetchFirstTransactionDate } from "./activity.service"
import { classifyWindow, incomeForPeriod, spendForPeriod } from "./classification.service"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

// One entry per period (M7.2). `month` is kept as the period key for callers
// that still read it; for start day 1 a period is a calendar month.
export interface CashFlowPeriod extends Period {
  month: string
  income: number
  expenses: number
  net: number
  /** 0 means no transactions in this period — shown as a zero bar, not skipped. */
  txCount: number
}

/**
 * M7.3: "classifier" is the live path; "legacy" keeps the pre-M7.3 code
 * reachable for scripts/reconcile-m73.ts until every endpoint is converted.
 */
export type CashFlowEngine = "classifier" | "legacy"

const round2 = (n: number) => Math.round(n * 100) / 100

export async function fetchCashFlow(
  userId: string = DEFAULT_USER_ID,
  periodCount: number = 6,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
  engine: CashFlowEngine = "classifier",
): Promise<{ cashflow: CashFlowPeriod[]; periodStartDay: number }> {
  const count = Math.min(Math.max(Math.trunc(periodCount) || 6, 1), 24)
  // Periods from before the user's first transaction are dropped (a period they
  // didn't exist in, which would drag averages); empty periods after it stay.
  const periods = periodsFromFirstActivity(
    recentPeriods(now, startDay, count),
    await fetchFirstTransactionDate(userId),
  )
  if (periods.length === 0) return { cashflow: [], periodStartDay: startDay }

  return engine === "legacy"
    ? fetchCashFlowLegacy(userId, periods, startDay)
    : fetchCashFlowClassified(userId, periods, startDay)
}

// ── M7.3: the classifier path ─────────────────────────────────────

async function fetchCashFlowClassified(
  userId: string,
  periods: Period[],
  startDay: number,
): Promise<{ cashflow: CashFlowPeriod[]; periodStartDay: number }> {
  const { rows, paymentAppByPeriod } = await classifyWindow(userId, {
    since: fromDateKey(periods[0].start),
    until: fromDateKey(periods[periods.length - 1].end),
    startDay,
  })

  const cashflow: CashFlowPeriod[] = periods.map((p) => {
    const income = incomeForPeriod(rows, p.key, startDay)
    const expenses = spendForPeriod(rows, p.key, startDay, paymentAppByPeriod)
    // Pending rows now count everywhere, so they count here too: a period's bar
    // should not jump when yesterday's card swipe settles.
    const txCount = rows.filter((r) => periodKeyOf(r.date, startDay) === p.key).length
    return {
      ...p,
      month: p.key,
      income,
      expenses,
      net: round2(income - expenses),
      txCount,
    }
  })

  return { cashflow, periodStartDay: startDay }
}

// ── pre-M7.3, kept reachable until every endpoint is converted ────

async function fetchCashFlowLegacy(
  userId: string,
  periods: Period[],
  startDay: number,
): Promise<{ cashflow: CashFlowPeriod[]; periodStartDay: number }> {
  const since = fromDateKey(periods[0].start)
  const until = fromDateKey(periods[periods.length - 1].end)

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      pending: false,
      date: { gte: since, lt: until },
    },
    select: { amount: true, date: true },
    orderBy: { date: "asc" },
  })

  const byPeriod: Record<string, { income: number; expenses: number; txCount: number }> = {}
  for (const tx of transactions) {
    const key = periodKeyOf(tx.date, startDay)
    const bucket = (byPeriod[key] ??= { income: 0, expenses: 0, txCount: 0 })
    const amount = tx.amount.toNumber()
    if (amount < 0) bucket.income += Math.abs(amount)
    else bucket.expenses += amount
    bucket.txCount += 1
  }

  // Every remaining period is returned, including empty ones: skipping a
  // period with no transactions hides the gap.
  const cashflow: CashFlowPeriod[] = periods.map((p) => {
    const { income, expenses, txCount } = byPeriod[p.key] ?? { income: 0, expenses: 0, txCount: 0 }
    return {
      ...p,
      month: p.key,
      income: Math.round(income * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      net: Math.round((income - expenses) * 100) / 100,
      txCount,
    }
  })

  return { cashflow, periodStartDay: startDay }
}
