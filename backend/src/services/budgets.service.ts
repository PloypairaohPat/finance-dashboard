import prisma from "../lib/prisma"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

export interface BudgetWithSpend {
  category:     string
  monthlyLimit: number
  currentSpend: number
  percentUsed:  number
  remaining:    number
  status:       "on_track" | "warning" | "over"
  month:        string
}

// Returns current YYYY-MM string, e.g. "2026-04"
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

// Upsert a budget limit for a category + month
export async function upsertBudget(
  category: string,
  monthlyLimit: number,
  month: string = currentMonth()
): Promise<void> {
  await prisma.budget.upsert({
    where: {
      userId_category_month: {
        userId: DEFAULT_USER_ID,
        category,
        month,
      },
    },
    update: { monthlyLimit },
    create: {
      userId:       DEFAULT_USER_ID,
      category,
      monthlyLimit,
      month,
    },
  })
}

// Fetch all budgets for a given month with real spend joined from transactions
export async function fetchBudgetsWithSpend(
  month: string = currentMonth()
): Promise<BudgetWithSpend[]> {
  // 1. Get all budget records for this month
  const budgets = await prisma.budget.findMany({
    where: { userId: DEFAULT_USER_ID, month },
  })

  if (budgets.length === 0) return []

  // 2. Get all posted transactions in this calendar month
  const monthStart = new Date(`${month}-01T00:00:00.000Z`)
  const monthEnd   = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const transactions = await prisma.transaction.findMany({
    where: {
      userId:    DEFAULT_USER_ID,
      deletedAt: null,
      pending:   false,
      amount:    { gt: 0 },
      date:      { gte: monthStart, lt: monthEnd },
    },
    select: { categoryPrimary: true, amount: true },
  })

  // 3. Build spend map: category -> total
  const spendMap: Record<string, number> = {}
  for (const tx of transactions) {
    const cat = tx.categoryPrimary ?? "Uncategorized"
    spendMap[cat] = (spendMap[cat] ?? 0) + tx.amount.toNumber()
  }

  // 4. Join budgets with spend
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

// Summary: how many categories are over, warning, or on track
export async function fetchBudgetStatus(month: string = currentMonth()) {
  const budgets = await fetchBudgetsWithSpend(month)
  return {
    month,
    total:    budgets.length,
    on_track: budgets.filter((b) => b.status === "on_track").length,
    warning:  budgets.filter((b) => b.status === "warning").length,
    over:     budgets.filter((b) => b.status === "over").length,
    budgets,
  }
}