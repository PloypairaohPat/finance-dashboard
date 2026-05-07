/**
 * One-time backfill: reconstructs ~90 days of daily BalanceSnapshot rows.
 *
 * Strategy: start from each account's current DB balance and walk backward
 * through transaction history, un-applying each day's net cash flow.
 *
 * Plaid amount convention: positive = money OUT (debit), negative = money IN (credit).
 * So:  balance_D-1 = balance_D + sum(amounts on day D)
 *
 * Existing rows are SKIPPED (createMany skipDuplicates) so real live snapshots
 * are never overwritten by estimates.
 *
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/backfill-snapshots.ts
 *   # or target a single user:
 *   BACKFILL_USER_ID=<clerkUserId> npx ts-node src/scripts/backfill-snapshots.ts
 */

import { PrismaClient, Prisma } from "@prisma/client"
const prisma = new PrismaClient()

const BACKFILL_DAYS = 90

async function backfillUser(userId: string) {
  console.log(`\n🔄 Backfilling user: ${userId}`)

  const accounts = await prisma.account.findMany({
    where: { userId },
    select: {
      id: true,              // used in Transaction.accountId
      plaidAccountId: true,  // used as BalanceSnapshot.accountId
      name: true,
      type: true,
      currentBalance: true,
      isoCurrencyCode: true,
    },
  })

  if (accounts.length === 0) {
    console.log("  No accounts found — skipping.")
    return
  }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const cutoff = new Date(today)
  cutoff.setDate(cutoff.getDate() - BACKFILL_DAYS)

  // Fetch all transactions in the backfill window (all amounts, all accounts)
  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      date: { gte: cutoff },
    },
    select: {
      accountId: true,   // Account.id (CUID)
      date: true,
      amount: true,
    },
  })

  // Build a map: accountCuid -> dateStr -> netFlow
  // netFlow = sum of Plaid amounts (positive = debit, negative = credit)
  const flowMap = new Map<string, Map<string, number>>()
  for (const tx of transactions) {
    if (!flowMap.has(tx.accountId)) flowMap.set(tx.accountId, new Map())
    const dayMap = flowMap.get(tx.accountId)!
    const dateKey = tx.date.toISOString().slice(0, 10)
    dayMap.set(dateKey, (dayMap.get(dateKey) ?? 0) + Number(tx.amount))
  }

  // Build the list of date strings from today backward
  const dates: string[] = []
  for (let i = 0; i < BACKFILL_DAYS; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }
  // dates[0] = today, dates[1] = yesterday, ..., dates[N-1] = oldest

  let totalSkipped = 0
  let totalCreated = 0

  for (const acct of accounts) {
    const dayFlow = flowMap.get(acct.id) ?? new Map<string, number>()

    // Walk backward: dates[0] = today (use currentBalance), then reconstruct
    let runningBalance = Number(acct.currentBalance ?? 0)

    const toCreate: Prisma.BalanceSnapshotCreateManyInput[] = []

    for (const dateStr of dates) {
      const dayDate = new Date(dateStr + "T00:00:00Z")
      toCreate.push({
        userId,
        accountId:        acct.plaidAccountId,
        accountName:      acct.name,
        accountType:      acct.type,
        currentBalance:   new Prisma.Decimal(runningBalance.toFixed(2)),
        availableBalance: null,
        isoCurrencyCode:  acct.isoCurrencyCode ?? "USD",
        date:             dayDate,
      })

      // Roll back one more day:
      // balance_on_(dateStr-1) = balance_on_dateStr + netFlow_on_dateStr
      const netFlow = dayFlow.get(dateStr) ?? 0
      runningBalance = runningBalance + netFlow
    }

    // createMany with skipDuplicates preserves any real snapshots already there
    const result = await prisma.balanceSnapshot.createMany({
      data: toCreate,
      skipDuplicates: true,
    })
    totalCreated += result.count
    totalSkipped += toCreate.length - result.count
    console.log(`  ${acct.name}: ${result.count} created, ${toCreate.length - result.count} already existed`)
  }

  console.log(`  ✅ Total: ${totalCreated} created, ${totalSkipped} skipped (already had real data)`)
}

async function main() {
  const targetUserId = process.env.BACKFILL_USER_ID

  if (targetUserId) {
    await backfillUser(targetUserId)
  } else {
    // Backfill all users that have linked Plaid items
    const rows = await prisma.plaidItem.findMany({
      select: { userId: true },
      distinct: ["userId"],
    })
    console.log(`Found ${rows.length} user(s) to backfill.`)
    for (const { userId } of rows) {
      await backfillUser(userId)
    }
  }

  await prisma.$disconnect()
  console.log("\n🎉 Backfill complete.")
}

main().catch(err => {
  console.error("Backfill failed:", err)
  prisma.$disconnect()
  process.exit(1)
})
