import prisma from "../lib/prisma"

export interface BudgetWithSpend {
  category:     string
  monthlyLimit: number
  currentSpend: number
  percentUsed:  number
  remaining:    number
  status:       "on_track" | "warning" | "over"
  month:        string
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
  await prisma.budget.upsert({
    where: {
      userId_category_month: { userId, category, month },
    },
    update: { monthlyLimit },
    create: { userId, category, monthlyLimit, month },
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
  const monthEnd   = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      pending:   false,
      amount:    { gt: 0 },
      date:      { gte: monthStart, lt: monthEnd },
    },
    select: { categoryPrimary: true, amount: true },
  })

  const spendMap: Record<string, number> = {}
  for (const tx of transactions) {
    const cat = tx.categoryPrimary ?? "Uncategorized"
    spendMap[cat] = (spendMap[cat] ?? 0) + tx.amount.toNumber()
  }

  return budgets.map((b) => {
    const limit        = b.monthlyLimit.toNumber()
    const spend        = Math.round((spendMap[b.category] ?? 0) * 100) / 100
    const pct          = limit > 0 ? Math.round((spend / limit) * 1000) / 10 : 0
    const remaining    = Math.round((limit - spend) * 100) / 100
    const status: BudgetWithSpend["status"] =
      pct >= 100 ? "over" : pct >= 75 ? "warning" : "on_track"

    return {
      category:     b.category,
      monthlyLimit: limit,
      currentSpend: spend,
      percentUsed:  pct,
      remaining,
      status,
      month,
    }
  })
}

export async function fetchBudgetStatus(userId: string, month: string = currentMonth()) {
  const budgets = await fetchBudgetsWithSpend(userId, month)
  return {
    month,
    total:    budgets.length,
    on_track: budgets.filter((b) => b.status === "on_track").length,
    warning:  budgets.filter((b) => b.status === "warning").length,
    over:     budgets.filter((b) => b.status === "over").length,
    budgets,
  }
}
