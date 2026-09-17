import prisma from "../../lib/prisma"
import {
  classifyWindow,
  ordinarySpendByBucketForRows,
  paymentAppFlowsForRows,
  type ClassifiedRow,
} from "../classification.service"
import { getPeriodStartDay } from "../user.service"

export interface WeeklyDigest {
  weekStart: string
  weekEnd: string
  /** Ordinary spending this week, refunds netted. Payments to people are NOT in here. */
  spent: number
  income: number
  /** Payments to people, as two gross sums. Deliberately never netted into one figure. */
  paymentsToPeople: { out: number; in: number }
  /** income − spent. Payments to people are reported beside it, not folded into it. */
  netSaved: number
  newAlertCount: number
  biggestMover: { category: string; pctChange: number } | null
  summary: string
}

export async function buildWeeklyDigest(userId: string): Promise<WeeklyDigest> {
  const now = new Date()
  const day = now.getUTCDay() || 7
  const weekStart = new Date(now); weekStart.setUTCDate(now.getUTCDate() - (day - 1)); weekStart.setUTCHours(0, 0, 0, 0)
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 7)
  const prevWeekStart = new Date(weekStart); prevWeekStart.setUTCDate(weekStart.getUTCDate() - 7)

  // M7.3: classified rows, so a transfer between your own accounts is no longer
  // a week's income and paying a card is no longer a week's spending.
  //
  // A week is NOT a money period, and that decides how payments to people are
  // reported. The payment-app cap is period-scoped — its floor at zero turns a
  // slice of a period into a confidently wrong figure, not a slightly-off one —
  // so the digest never nets them. It reports what went out and what came back
  // as two plain sums over the week's rows, which are safe over any date range.
  const startDay = await getPeriodStartDay(userId)
  const [classification, recentAlerts] = await Promise.all([
    classifyWindow(userId, { since: prevWeekStart, until: weekEnd, startDay }),
    prisma.alert.count({
      where: { userId, deletedAt: null, triggeredAt: { gte: weekStart, lt: weekEnd } },
    }),
  ])

  const inWeek = (row: ClassifiedRow, from: Date, to: Date) => row.date >= from && row.date < to
  const thisWeekRows = classification.rows.filter((r) => inWeek(r, weekStart, weekEnd))
  const lastWeekRows = classification.rows.filter((r) => inWeek(r, prevWeekStart, weekStart))

  const thisCats = ordinarySpendByBucketForRows(thisWeekRows)
  const lastCats = ordinarySpendByBucketForRows(lastWeekRows)
  const paymentsToPeople = paymentAppFlowsForRows(thisWeekRows)

  const spent = Object.values(thisCats).reduce((s, v) => s + v, 0)
  const income = thisWeekRows
    .filter((r) => r.verdict.kind === "income")
    .reduce((s, r) => s + Math.abs(r.amount), 0)

  let biggestMover: WeeklyDigest["biggestMover"] = null
  for (const c of Object.keys(thisCats)) {
    const prev = lastCats[c] ?? 0
    if (prev < 30) continue
    const pct = ((thisCats[c] - prev) / prev) * 100
    if (!biggestMover || Math.abs(pct) > Math.abs(biggestMover.pctChange)) {
      biggestMover = { category: c, pctChange: pct }
    }
  }

  const netSaved = Number((income - spent).toFixed(2))
  const savingSign = netSaved >= 0 ? "+" : "−"
  const parts = [
    `You ${netSaved >= 0 ? "saved" : "spent more than you earned"} ${savingSign}$${Math.abs(netSaved).toFixed(0)} this week.`,
  ]
  if (biggestMover) {
    parts.push(
      `Biggest mover: ${biggestMover.category} ${biggestMover.pctChange > 0 ? "up" : "down"} ${Math.abs(biggestMover.pctChange).toFixed(0)}%.`,
    )
  }
  if (paymentsToPeople.out > 0 || paymentsToPeople.in > 0) {
    parts.push(
      `Payments to people: $${paymentsToPeople.out.toFixed(0)} out, $${paymentsToPeople.in.toFixed(0)} in.`,
    )
  }

  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: new Date(weekEnd.getTime() - 86400000).toISOString().slice(0, 10),
    spent: Number(spent.toFixed(2)),
    income: Number(income.toFixed(2)),
    paymentsToPeople,
    netSaved,
    newAlertCount: recentAlerts,
    biggestMover,
    summary: parts.join(" "),
  }
}
