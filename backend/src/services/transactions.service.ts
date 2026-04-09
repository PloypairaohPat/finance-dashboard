import prisma from '../lib/prisma'

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID!

export async function fetchTransactions() {
  return prisma.transaction.findMany({
    where:   { userId: DEFAULT_USER_ID, deletedAt: null },
    orderBy: { date: 'desc' },
    take:    200,
  })
}

export async function fetchCategoryTotals() {
  const grouped = await prisma.transaction.groupBy({
    by: ['categoryPrimary'],
    where: {
      userId:    DEFAULT_USER_ID,
      deletedAt: null,
      pending:   false,
      amount:    { gt: 0 },
      categoryPrimary: {
        not:   null,
        notIn: ['TRANSFER_OUT', 'TRANSFER_IN'],
      },
    },
    _sum:    { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
  })

  return grouped.map((row) => ({
    name:  row.categoryPrimary,
    total: Number(row._sum.amount || 0),
  }))
}

export interface MonthlyTotal {
  month:   string   // "2026-01"
  label:   string   // "Jan 2026"
  total:   number
  txCount: number
}

export async function fetchMonthlyTotals(months: number = 12): Promise<MonthlyTotal[]> {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)

  const rows = await prisma.transaction.findMany({
    where: {
      userId:    DEFAULT_USER_ID,
      deletedAt: null,
      pending:   false,
      amount:    { gt: 0 },
      date:      { gte: cutoff },
    },
    select: { date: true, amount: true },
  })

  const map: Record<string, { total: number; count: number }> = {}
  for (const tx of rows) {
    const key = tx.date.toISOString().slice(0, 7)
    if (!map[key]) map[key] = { total: 0, count: 0 }
    map[key].total += tx.amount.toNumber()
    map[key].count += 1
  }

  return Object.entries(map)
    .map(([month, { total, count }]) => ({
      month,
      label:   formatMonthLabel(month),
      total:   Math.round(total * 100) / 100,
      txCount: count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

function formatMonthLabel(yyyymm: string): string {
  const [year, month] = yyyymm.split('-')
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[parseInt(month) - 1]} ${year}`
}