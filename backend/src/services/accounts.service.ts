import prisma from '../lib/prisma'

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID!

export async function fetchAccounts() {
  return prisma.account.findMany({
    where:   { userId: DEFAULT_USER_ID },
    orderBy: { name: 'asc' },
  })
}