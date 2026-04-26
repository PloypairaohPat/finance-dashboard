import prisma from "../../lib/prisma"
import { isSpending, mapPlaidCategory } from "../../lib/categoryMap"

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

  const [thisWeekTxs, lastWeekTxs, recentAlerts] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, date: { gte: weekStart, lt: weekEnd } },
    }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, date: { gte: prevWeekStart, lt: weekStart } },
    }),
    prisma.alert.count({
      where: { userId, deletedAt: null, triggeredAt: { gte: weekStart, lt: weekEnd } },
    }),
  ])

  let spent = 0, income = 0
  for (const tx of thisWeekTxs) {
    const amt = Number(tx.amount)
    if (amt > 0 && isSpending(tx.categoryPrimary)) spent += amt
    else if (amt < 0) income += Math.abs(amt)
  }

  const thisCats: Record<string, number> = {}
  const lastCats: Record<string, number> = {}
  for (const tx of thisWeekTxs) {
    const amt = Number(tx.amount)
    if (amt > 0 && isSpending(tx.categoryPrimary)) {
      const c = mapPlaidCategory(tx.categoryPrimary)
      thisCats[c] = (thisCats[c] ?? 0) + amt
    }
  }
  for (const tx of lastWeekTxs) {
    const amt = Number(tx.amount)
    if (amt > 0 && isSpending(tx.categoryPrimary)) {
      const c = mapPlaidCategory(tx.categoryPrimary)
      lastCats[c] = (lastCats[c] ?? 0) + amt
    }
  }

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