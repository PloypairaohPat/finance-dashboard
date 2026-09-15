import prisma from "../lib/prisma"
import {
  DEFAULT_PERIOD_START_DAY,
  fromDateKey,
  periodKeyOf,
  recentPeriods,
  type Period,
} from "../lib/period"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

// One entry per period (M7.2). `month` is kept as the period key for callers
// that still read it; for start day 1 a period is a calendar month.
export interface CashFlowPeriod extends Period {
  month: string
  income: number
  expenses: number
  net: number
  /** 0 means no settled transactions in this period — shown as a zero bar, not skipped. */
  txCount: number
}

export async function fetchCashFlow(
  userId: string = DEFAULT_USER_ID,
  periodCount: number = 6,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
): Promise<{ cashflow: CashFlowPeriod[]; periodStartDay: number }> {
  const count = Math.min(Math.max(Math.trunc(periodCount) || 6, 1), 24)
  const periods = recentPeriods(now, startDay, count)
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

  // Every period in the window is returned, including empty ones: skipping a
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
