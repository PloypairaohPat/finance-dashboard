import prisma from "../lib/prisma"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

// ── Range types ────────────────────────────────────────────────
export type Range = "1M" | "3M" | "6M" | "1Y" | "All"

const RANGE_DAYS: Record<Range, number> = {
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "All": Number.POSITIVE_INFINITY,
}

const normalizeRange = (raw: unknown): Range => {
  const s = String(raw ?? "").toUpperCase()
  if (s === "ALL") return "All"
  if ((["1M", "3M", "6M", "1Y"] as const).includes(s as any)) return s as Range
  return "6M"
}

// ── Response types ─────────────────────────────────────────────
export interface NetWorthPoint {
  date: string
  netWorth: number
  assets: number
  liabilities: number
  depository: number
  investment: number
  credit: number
  loan: number
}

export interface NetWorthSummary {
  firstNetWorth: number | null
  lastNetWorth: number | null
  deltaAbs: number | null
  deltaPct: number | null
  rangeApplied: Range
  dataLimited: boolean
  daysCovered: number
}

export interface NetWorthResponse {
  history: NetWorthPoint[]
  summary: NetWorthSummary
}

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
  rawRange?: unknown,
): Promise<NetWorthResponse> {
  const range = normalizeRange(rawRange)
  const days = RANGE_DAYS[range]

  const now = new Date()
  const cutoff =
    days === Number.POSITIVE_INFINITY
      ? new Date(0)
      : new Date(now.getTime() - days * 86400000)

  const snapshots = await prisma.balanceSnapshot.findMany({
    where: {
      userId,
      date: { gte: cutoff },
    },
    orderBy: { date: "asc" },
  })

  // Group by calendar day
  const byDate = new Map<string, typeof snapshots>()
  for (const s of snapshots) {
    const key = s.date.toISOString().slice(0, 10)
    const arr = byDate.get(key) ?? []
    arr.push(s)
    byDate.set(key, arr)
  }

  // Build history with per-type decomposition
  const history: NetWorthPoint[] = []
  for (const [date, rows] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let depository = 0, investment = 0, credit = 0, loan = 0
    for (const r of rows) {
      const bal = Number(r.currentBalance ?? 0)
      switch (r.accountType) {
        case "depository": depository += bal; break
        case "investment":  investment += bal; break
        case "credit":      credit += Math.abs(bal); break
        case "loan":        loan += Math.abs(bal); break
      }
    }
    const assets = Number((depository + investment).toFixed(2))
    const liabilities = Number((credit + loan).toFixed(2))
    history.push({
      date,
      depository: Number(depository.toFixed(2)),
      investment: Number(investment.toFixed(2)),
      credit: Number(credit.toFixed(2)),
      loan: Number(loan.toFixed(2)),
      assets,
      liabilities,
      netWorth: Number((assets - liabilities).toFixed(2)),
    })
  }

  // Summary stats
  const first = history[0] ?? null
  const last = history[history.length - 1] ?? null
  const deltaAbs =
    first && last ? Number((last.netWorth - first.netWorth).toFixed(2)) : null
  const deltaPct =
    first && last && first.netWorth !== 0
      ? Number((((last.netWorth - first.netWorth) / Math.abs(first.netWorth)) * 100).toFixed(1))
      : null

  // Is the range wider than available data?
  const oldestAny = await prisma.balanceSnapshot.findFirst({
    where: { userId },
    orderBy: { date: "asc" },
    select: { date: true },
  })
  const dataLimited =
    days !== Number.POSITIVE_INFINITY && !!oldestAny && oldestAny.date > cutoff

  return {
    history,
    summary: {
      firstNetWorth: first?.netWorth ?? null,
      lastNetWorth: last?.netWorth ?? null,
      deltaAbs,
      deltaPct,
      rangeApplied: range,
      dataLimited,
      daysCovered: history.length,
    },
  }
}