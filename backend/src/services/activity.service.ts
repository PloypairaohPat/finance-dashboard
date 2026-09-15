import prisma from "../lib/prisma"

// The date of a user's first transaction, or null if they have none.
//
// Period-grouped endpoints use it to drop periods from before the user had any
// history (lib/period.ts periodsFromFirstActivity): a zero there isn't a gap,
// it's a period they didn't exist in. Pending and settled both count — either
// means the account was active.
export async function fetchFirstTransactionDate(userId: string): Promise<Date | null> {
  const first = await prisma.transaction.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { date: "asc" },
    select: { date: true },
  })
  return first?.date ?? null
}
