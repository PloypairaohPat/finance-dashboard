import prisma from '../lib/prisma'

export async function fetchAccounts(userId: string) {
  const [accounts, syncAgg] = await Promise.all([
    prisma.account.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    prisma.plaidItem.aggregate({ where: { userId }, _max: { lastSyncedAt: true } }),
  ])
  return {
    accounts,
    lastSyncedAt: syncAgg._max.lastSyncedAt?.toISOString() ?? null,
  }
}
