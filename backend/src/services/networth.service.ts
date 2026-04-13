import prisma from "../lib/prisma"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

// ── Capture today's balance snapshot for all accounts ──────────
export async function captureBalanceSnapshots(userId: string = DEFAULT_USER_ID) {
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: {
      plaidAccountId: true,
      name: true,
      type: true,
      currentBalance: true,
      availableBalance: true,
      isoCurrencyCode: true,
    },
  })

  if (accounts.length === 0) return { captured: 0 }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  let captured = 0
  for (const acct of accounts) {
    try {
      await prisma.balanceSnapshot.upsert({
        where: {
          accountId_date: {
            accountId: acct.plaidAccountId,
            date: today,
          },
        },
        update: {
          currentBalance: acct.currentBalance ?? 0,
          availableBalance: acct.availableBalance,
          accountName: acct.name,
          accountType: acct.type,
        },
        create: {
          userId,
          accountId: acct.plaidAccountId,
          accountName: acct.name,
          accountType: acct.type,
          currentBalance: acct.currentBalance ?? 0,
          availableBalance: acct.availableBalance,
          isoCurrencyCode: acct.isoCurrencyCode ?? "USD",
          date: today,
        },
      })
      captured++
    } catch (err: any) {
      console.error(`Snapshot failed for ${acct.name}:`, err.message)
    }
  }

  console.log(`📸 Captured ${captured} balance snapshots for ${today.toISOString().slice(0, 10)}`)
  return { captured }
}

// ── Fetch net worth history ────────────────────────────────────
export async function fetchNetWorthHistory(
  userId: string = DEFAULT_USER_ID,
  days: number = 90
) {
  const since = new Date()
  since.setDate(since.getDate() - days)
  since.setUTCHours(0, 0, 0, 0)

  const snapshots = await prisma.balanceSnapshot.findMany({
    where: {
      userId,
      date: { gte: since },
    },
    orderBy: { date: "asc" },
  })

  const dateMap: Record<string, { assets: number; liabilities: number }> = {}

  for (const snap of snapshots) {
    const dateKey = snap.date.toISOString().slice(0, 10)
    if (!dateMap[dateKey]) dateMap[dateKey] = { assets: 0, liabilities: 0 }

    const balance = snap.currentBalance.toNumber()

    if (snap.accountType === "credit") {
      dateMap[dateKey].liabilities += Math.abs(balance)
    } else {
      dateMap[dateKey].assets += balance
    }
  }

  const history = Object.entries(dateMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { assets, liabilities }]) => ({
      date,
      assets: Math.round(assets * 100) / 100,
      liabilities: Math.round(liabilities * 100) / 100,
      netWorth: Math.round((assets - liabilities) * 100) / 100,
    }))

  return { history }
}