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

const round2 = (n: number) => Math.round(n * 100) / 100

export async function fetchCashFlow(
  userId: string,
  periodCount: number = 6,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
): Promise<{ cashflow: CashFlowPeriod[]; periodStartDay: number }> {
  const count = Math.min(Math.max(Math.trunc(periodCount) || 6, 1), 24)
  // Periods from before the user's first transaction are dropped (a period they
  // didn't exist in, which would drag averages); empty periods after it stay.
  const periods = periodsFromFirstActivity(
    recentPeriods(now, startDay, count),
    await fetchFirstTransactionDate(userId),
  )
  if (periods.length === 0) return { cashflow: [], periodStartDay: startDay }

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
