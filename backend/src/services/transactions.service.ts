import prisma from '../lib/prisma'

export async function fetchTransactions(userId: string) {
  return prisma.transaction.findMany({
    where:   { userId, deletedAt: null },
    orderBy: { date: 'desc' },
    take:    200,
  })
}

export async function fetchCategoryTotals(userId: string) {
  const grouped = await prisma.transaction.groupBy({
    by: ['categoryPrimary'],
    where: {
      userId,
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
  month:   string
  label:   string
  total:   number
  txCount: number
}

export async function fetchMonthlyTotals(userId: string, months: number = 12): Promise<MonthlyTotal[]> {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
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

// ── M3.3: Server-side search with filters ──────────────────────
interface SearchFilters {
  q?:          string
  category?:   string
  dateFrom?:   string
  dateTo?:     string
  minAmount?:  number
  maxAmount?:  number
  tag?:        string
  sortBy?:     string
  limit?:      number
  offset?:     number
}

export async function searchTransactions(userId: string, filters: SearchFilters) {
  const where: any = { userId, deletedAt: null }

  if (filters.q) {
    const q = filters.q.trim()
    where.OR = [
      { cleanName:    { contains: q, mode: "insensitive" } },
      { merchantName: { contains: q, mode: "insensitive" } },
      { name:         { contains: q, mode: "insensitive" } },
      { notes:        { contains: q, mode: "insensitive" } },
    ]
  }

  if (filters.category) {
    where.categoryPrimary = filters.category
  }

  if (filters.dateFrom || filters.dateTo) {
    where.date = {}
    if (filters.dateFrom) where.date.gte = new Date(filters.dateFrom)
    if (filters.dateTo)   where.date.lte = new Date(filters.dateTo)
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    where.amount = {}
    if (filters.minAmount !== undefined) where.amount.gte = filters.minAmount
    if (filters.maxAmount !== undefined) where.amount.lte = filters.maxAmount
  }

  if (filters.tag) {
    where.tags = { has: filters.tag }
  }

  let orderBy: any = { date: "desc" }
  switch (filters.sortBy) {
    case "date-asc":    orderBy = { date: "asc" };   break
    case "amount-desc": orderBy = { amount: "desc" }; break
    case "amount-asc":  orderBy = { amount: "asc" };  break
  }

  const limit  = Math.min(filters.limit  ?? 100, 500)
  const offset = filters.offset ?? 0

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy, take: limit, skip: offset }),
    prisma.transaction.count({ where }),
  ])

  return { transactions, total, limit, offset }
}

export async function updateTransaction(
  transactionId: string,
  data: { tags?: string[]; notes?: string | null }
) {
  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      ...(data.tags  !== undefined && { tags:  data.tags }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  })
}
