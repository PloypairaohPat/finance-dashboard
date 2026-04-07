import { PrismaClient } from '@prisma/client'

const AMOUNT_TOLERANCE = 0.05

export async function resolvePending(
  prisma: PrismaClient,
  userId: string
): Promise<{ resolved: number }> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 10)

  const recentPosted = await prisma.transaction.findMany({
    where: { userId, pending: false, deletedAt: null, date: { gte: cutoff } },
    select: { id: true, date: true, name: true, amount: true },
  })

  let resolved = 0

  for (const posted of recentPosted) {
    const postedAmt = posted.amount.toNumber()

    const pendingTwin = await prisma.transaction.findFirst({
      where: {
        userId,
        pending:   true,
        deletedAt: null,
        date:      posted.date,
        name:      { contains: posted.name.split(' ')[0], mode: 'insensitive' },
        amount: {
          gte: postedAmt * (1 - AMOUNT_TOLERANCE),
          lte: postedAmt * (1 + AMOUNT_TOLERANCE),
        },
      },
    })

    if (pendingTwin) {
      await prisma.transaction.update({
        where: { id: pendingTwin.id },
        data:  { deletedAt: new Date() },
      })
      resolved++
    }
  }

  return { resolved }
}