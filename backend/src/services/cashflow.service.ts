import prisma from "../lib/prisma"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

export interface CashFlowMonth {
  month: string
  income: number
  expenses: number
  net: number
}

export async function fetchCashFlow(
  userId: string = DEFAULT_USER_ID,
  months: number = 6
): Promise<{ cashflow: CashFlowMonth[] }> {
  const since = new Date()
  since.setMonth(since.getMonth() - months + 1)
  since.setDate(1)
  since.setHours(0, 0, 0, 0)

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      pending: false,
      date: { gte: since },
    },
    select: { amount: true, date: true },
    orderBy: { date: "asc" },
  })

  const monthMap: Record<string, { income: number; expenses: number }> = {}

  for (const tx of transactions) {
    const monthKey = tx.date.toISOString().slice(0, 7)
    if (!monthMap[monthKey]) {
      monthMap[monthKey] = { income: 0, expenses: 0 }
    }

    const amount = tx.amount.toNumber()

    if (amount < 0) {
      monthMap[monthKey].income += Math.abs(amount)
    } else {
      monthMap[monthKey].expenses += amount
    }
  }

  const cashflow: CashFlowMonth[] = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { income, expenses }]) => ({
      month,
      income: Math.round(income * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      net: Math.round((income - expenses) * 100) / 100,
    }))

  return { cashflow }
}