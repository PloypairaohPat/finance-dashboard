import prisma from "../lib/prisma"
import {
  mapPlaidCategory,
  DISPLAY_CATEGORIES,
} from "../lib/categoryMap"

export type BudgetStatus =
  | "on_track"
  | "warning"
  | "over"
  | "projected_over"

export interface BudgetWithSpend {
  id: string
  category: string
  monthlyLimit: number
  currentSpend: number
  percentUsed: number
  remaining: number
  projected: number | null
  status: BudgetStatus
  month: string
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export async function upsertBudget(
  userId: string,
  category: string,
  monthlyLimit: number,
  month: string = currentMonth()
): Promise<void> {
  if (!(DISPLAY_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error("Invalid category")
  }

  await prisma.budget.upsert({
    where: {
      userId_category_month: { userId, category, month },
    },
    update: { monthlyLimit },
    create: { userId, category, monthlyLimit, month },
  })
}

export async function deleteBudget(
  userId: string,
  budgetId: string
): Promise<void> {
  await prisma.budget.deleteMany({
    where: { id: budgetId, userId },
  })
}

export async function fetchBudgetsWithSpend(
  userId: string,
  month: string = currentMonth()
): Promise<BudgetWithSpend[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId, month },
  })

  if (budgets.length === 0) return []

  const monthStart = new Date(`${month}-01T00:00:00.000Z`)
  const monthEnd = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const now = new Date()
  const isCurrentMonth = month === currentMonth()

  const day = isCurrentMonth ? now.getDate() : 0
  const daysInMonth = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth() + 1,
    0
  ).getDate()

  const projectionAllowed = isCurrentMonth && day >= 7

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      pending: false,
      amount: { gt: 0 },
      date: { gte: monthStart, lt: monthEnd },
    },
    select: {
      categoryPrimary: true,
      amount: true,
    },
  })

  const spendMap: Record<string, number> = {}

  for (const tx of transactions) {
    const mapped = mapPlaidCategory(tx.categoryPrimary)
    spendMap[mapped] = (spendMap[mapped] ?? 0) + tx.amount.toNumber()
  }

  return budgets.map((b) => {
    const limit = b.monthlyLimit.toNumber()
    const spend = Math.round((spendMap[b.category] ?? 0) * 100) / 100
    const pct = limit > 0 ? Math.round((spend / limit) * 1000) / 10 : 0
    const remaining = Math.round((limit - spend) * 100) / 100
    const projected =
      projectionAllowed && day > 0
        ? Math.round(((spend / day) * daysInMonth) * 100) / 100
        : null

    let status: BudgetStatus
    if (pct >= 100) status = "over"
    else if (projected !== null && projected > limit) status = "projected_over"
    else if (pct >= 75) status = "warning"
    else status = "on_track"

    return {
      id: b.id,
      category: b.category,
      monthlyLimit: limit,
      currentSpend: spend,
      percentUsed: pct,
      remaining,
      projected,
      status,
      month,
    }
  })
}

export async function fetchBudgetStatus(
  userId: string,
  month: string = currentMonth()
) {
  const budgets = await fetchBudgetsWithSpend(userId, month)

  return {
    month,
    total: budgets.length,
    on_track: budgets.filter((b) => b.status === "on_track").length,
    warning: budgets.filter((b) => b.status === "warning").length,
    over: budgets.filter((b) => b.status === "over").length,
    projected_over: budgets.filter((b) => b.status === "projected_over").length,
    budgets,
  }
}