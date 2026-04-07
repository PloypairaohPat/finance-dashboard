import { PrismaClient }      from '@prisma/client'
import { normalizeMerchant } from '../utils/normalizer'
import { resolvePending }    from '../utils/pendingResolver'

export interface CleanResult {
  normalized: number
  resolved:   number
}

export async function cleanTransactions(
  prisma: PrismaClient,
  userId: string
): Promise<CleanResult> {
  // Pass 1: normalize merchant names — only rows missing cleanName
  const dirty = await prisma.transaction.findMany({
    where:  { userId, deletedAt: null, cleanName: null },
    select: { id: true, name: true, merchantName: true },
  })

  let normalized = 0
  for (const tx of dirty) {
    const cleanName = normalizeMerchant(tx.name, tx.merchantName)
    await prisma.transaction.update({
      where: { id: tx.id },
      data:  { cleanName },
    })
    normalized++
  }

  // Pass 2: resolve pending duplicates
  const { resolved } = await resolvePending(prisma, userId)

  return { normalized, resolved }
}