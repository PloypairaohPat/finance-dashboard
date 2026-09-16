import prisma from "../../lib/prisma"
import { PAYMENTS_TO_PEOPLE } from "../../lib/classifier"
import { classifyWindow, spendByBucketForRows, type ClassifiedRow } from "../classification.service"
import { getPeriodStartDay } from "../user.service"

export interface WeeklyDigest {
  weekStart: string
  weekEnd: string
  spent: number
  income: number
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
  // A week is NOT a money period, so the payment-app total here is netted within
  // the week rather than capped per period. That is a different quantity, by
  // design: a weekly digest reports the week. It means these figures do not sum
  // to the period figures on the Overview, and should not be expected to.
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

  const thisCats = spendByBucketForRows(thisWeekRows, PAYMENTS_TO_PEOPLE)
  const lastCats = spendByBucketForRows(lastWeekRows, PAYMENTS_TO_PEOPLE)

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
  const summary = biggestMover
    ? `You ${netSaved >= 0 ? "saved" : "spent more than you earned"} ${savingSign}$${Math.abs(netSaved).toFixed(0)} this week. Biggest mover: ${biggestMover.category} ${biggestMover.pctChange > 0 ? "up" : "down"} ${Math.abs(biggestMover.pctChange).toFixed(0)}%.`
    : `You ${netSaved >= 0 ? "saved" : "spent more than you earned"} ${savingSign}$${Math.abs(netSaved).toFixed(0)} this week.`

  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: new Date(weekEnd.getTime() - 86400000).toISOString().slice(0, 10),
    spent: Number(spent.toFixed(2)),
    income: Number(income.toFixed(2)),
    netSaved,
    newAlertCount: recentAlerts,
    biggestMover,
    summary,
  }
}