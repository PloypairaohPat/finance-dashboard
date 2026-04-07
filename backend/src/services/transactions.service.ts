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