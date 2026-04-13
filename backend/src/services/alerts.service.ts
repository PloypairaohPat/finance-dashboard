import prisma from "../lib/prisma"

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

export interface Alert {
  type:        "large_transaction" | "new_merchant" | "monthly_pace" | "budget_exceeded"
  severity:    "warning" | "critical"
  title:       string
  description: string
  amount?:     number
  category?:   string
  date?:       string
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function getMonthBounds(month: string): { start: Date; end: Date } {
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end   = new Date(start)
  end.setMonth(end.getMonth() + 1)
  return { start, end }
}

// ── 1. Large transaction detector ────────────────────────────────
async function detectLargeTransactions(): Promise<Alert[]> {
  const month = currentMonth()
  const { start, end } = getMonthBounds(month)

  const txs = await prisma.transaction.findMany({
    where: {
      userId: DEFAULT_USER_ID, deletedAt: null,
      pending: false, amount: { gt: 0 },
      date: { gte: start, lt: end },
    },
    select: { amount: true, categoryPrimary: true, name: true,
              merchantName: true, cleanName: true, date: true },
  })

  // Build category averages
  const catMap: Record<string, number[]> = {}
  for (const tx of txs) {
    const cat = tx.categoryPrimary ?? "OTHER"
    if (!catMap[cat]) catMap[cat] = []
    catMap[cat].push(tx.amount.toNumber())
  }

  const alerts: Alert[] = []
  for (const tx of txs) {
    const cat    = tx.categoryPrimary ?? "OTHER"
    const amounts = catMap[cat]
    if (amounts.length < 2) continue
    const avg    = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const amount = tx.amount.toNumber()
    if (amount > avg * 2 && amount > 50) {
      alerts.push({
        type:        "large_transaction",
        severity:    "warning",
        title:       "Large transaction detected",
        description: `${tx.cleanName || tx.merchantName || tx.name} is ${(amount / avg).toFixed(1)}× your usual ${cat.replace(/_/g, " ").toLowerCase()} spend`,
        amount,
        category:    cat,
        date:        tx.date.toISOString().slice(0, 10),
      })
    }
  }
  return alerts
}

// ── 2. New merchant detector ──────────────────────────────────────
async function detectNewMerchants(): Promise<Alert[]> {
  const month = currentMonth()
  const { start, end } = getMonthBounds(month)

  // All merchants ever seen before this month
  const historical = await prisma.transaction.findMany({
    where: {
      userId: DEFAULT_USER_ID, deletedAt: null,
      pending: false, date: { lt: start },
    },
    select: { merchantName: true, cleanName: true },
  })
  const knownMerchants = new Set(
    historical.map(t => (t.cleanName || t.merchantName || "").toLowerCase()).filter(Boolean)
  )

  // This month's transactions over $50
  const thisMonth = await prisma.transaction.findMany({
    where: {
      userId: DEFAULT_USER_ID, deletedAt: null,
      pending: false, amount: { gt: 50 },
      date: { gte: start, lt: end },
    },
    select: { amount: true, merchantName: true, cleanName: true,
              name: true, date: true, categoryPrimary: true },
  })

  const alerts: Alert[] = []
  const seen = new Set<string>()
  for (const tx of thisMonth) {
    const merchant = (tx.cleanName || tx.merchantName || tx.name || "").toLowerCase()
    if (!merchant || knownMerchants.has(merchant) || seen.has(merchant)) continue
    seen.add(merchant)
    alerts.push({
      type:        "new_merchant",
      severity:    "warning",
      title:       "New merchant",
      description: `First time spending at ${tx.cleanName || tx.merchantName || tx.name}`,
      amount:      tx.amount.toNumber(),
      category:    tx.categoryPrimary ?? undefined,
      date:        tx.date.toISOString().slice(0, 10),
    })
  }
  return alerts
}

// ── 3. Monthly pace detector ──────────────────────────────────────
async function detectMonthlyPace(): Promise<Alert[]> {
  const now       = new Date()
  const month     = currentMonth()
  const { start, end } = getMonthBounds(month)

  // Days elapsed and total days in month
  const daysElapsed = Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86400000))
  const daysInMonth = Math.floor((end.getTime() - start.getTime()) / 86400000)

  // Last month
  const lastMonthDate = new Date(start)
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1)
  const lastMonth = lastMonthDate.toISOString().slice(0, 7)
  const { start: lmStart, end: lmEnd } = getMonthBounds(lastMonth)

  const [thisMonthTxs, lastMonthTxs] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId: DEFAULT_USER_ID, deletedAt: null, pending: false,
               amount: { gt: 0 }, date: { gte: start, lt: end } },
      select: { amount: true },
    }),
    prisma.transaction.findMany({
      where: { userId: DEFAULT_USER_ID, deletedAt: null, pending: false,
               amount: { gt: 0 }, date: { gte: lmStart, lt: lmEnd } },
      select: { amount: true },
    }),
  ])

  const thisTotal = thisMonthTxs.reduce((s, t) => s + t.amount.toNumber(), 0)
  const lastTotal = lastMonthTxs.reduce((s, t) => s + t.amount.toNumber(), 0)
  if (lastTotal === 0) return []

  const projectedTotal = (thisTotal / daysElapsed) * daysInMonth
  const pctOver = ((projectedTotal - lastTotal) / lastTotal) * 100

  if (pctOver > 20) {
    return [{
      type:        "monthly_pace",
      severity:    "warning",
      title:       "Spending pace alert",
      description: `On pace to spend $${Math.round(projectedTotal).toLocaleString()} this month — ${Math.round(pctOver)}% more than last month ($${Math.round(lastTotal).toLocaleString()})`,
    }]
  }
  return []
}

// ── 4. Budget exceeded detector ───────────────────────────────────
async function detectBudgetExceeded(): Promise<Alert[]> {
  const month = currentMonth()
  const { start, end } = getMonthBounds(month)

  const budgets = await prisma.budget.findMany({
    where: { userId: DEFAULT_USER_ID, month },
  })
  if (budgets.length === 0) return []

  const txs = await prisma.transaction.findMany({
    where: { userId: DEFAULT_USER_ID, deletedAt: null, pending: false,
             amount: { gt: 0 }, date: { gte: start, lt: end } },
    select: { categoryPrimary: true, amount: true },
  })

  const spendMap: Record<string, number> = {}
  for (const tx of txs) {
    const cat = tx.categoryPrimary ?? "OTHER"
    spendMap[cat] = (spendMap[cat] ?? 0) + tx.amount.toNumber()
  }

  const alerts: Alert[] = []
  for (const b of budgets) {
    const spend = spendMap[b.category] ?? 0
    const limit = b.monthlyLimit.toNumber()
    if (spend > limit) {
      alerts.push({
        type:        "budget_exceeded",
        severity:    "critical",
        title:       "Budget exceeded",
        description: `${b.category.replace(/_/g, " ")} is $${(spend - limit).toFixed(2)} over your $${limit.toFixed(0)} budget`,
        amount:      spend,
        category:    b.category,
      })
    }
  }
  return alerts
}

// ── Main export ───────────────────────────────────────────────────
export async function fetchAlerts(): Promise<Alert[]> {
  const [large, newMerchant, pace, budget] = await Promise.all([
    detectLargeTransactions(),
    detectNewMerchants(),
    detectMonthlyPace(),
    detectBudgetExceeded(),
  ])
  return [...budget, ...pace, ...large, ...newMerchant]
}