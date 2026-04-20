import prisma from '../lib/prisma'

export async function fetchAccounts(userId: string) {
  return prisma.account.findMany({
    where:   { userId },
    orderBy: { name: 'asc' },
  })
}
