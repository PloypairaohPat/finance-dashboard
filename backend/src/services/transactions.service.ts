import prisma from '../lib/prisma'
import {
  mapPlaidCategory, isSpending,
  CATEGORY_COLORS, DISPLAY_CATEGORIES,
  type DisplayCategory,
} from "../lib/categoryMap"
import { getSubscriptionMerchants } from "./subscriptions.service"
import { plaidClient } from "../lib/plaidClient"

export async function fetchTransactions(userId: string) {
  return prisma.transaction.findMany({
    where:   { userId, deletedAt: null },
    orderBy: { date: 'desc' },
    take:    200,
  })
}

// ── M5.2: Replace fetchCategoryTotals with fetchCategorySpend ────────
// ── M5.5: Enhanced with subscription merchant override ────────────────
export async function fetchCategorySpend(userId: string, month?: string) {
  // month = YYYY-MM, defaults to current month
  const now = new Date()
  const ym = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const [yr, mo] = ym.split("-").map(Number)
  const start = new Date(Date.UTC(yr, mo - 1, 1))
  const end   = new Date(Date.UTC(yr, mo, 1))

  const txs = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      amount: { gt: 0 },             // expenses only (positive = money leaving)
      date: { gte: start, lt: end },
    },
    // M5.5: add cleanName + name so we can match against subscription merchants
    select: { amount: true, categoryPrimary: true, cleanName: true, name: true },
  })

  // M5.5: get subscription merchant set — gracefully falls back to empty on error
  let subMerchants: Set<string>
  try {
    subMerchants = await getSubscriptionMerchants(userId, plaidClient)
  } catch (err) {
    console.warn("Subscription override unavailable, falling back:", err)
    subMerchants = new Set()
  }

  // Sum into the 10 display buckets
  const buckets: Record<DisplayCategory, number> = Object.fromEntries(
    DISPLAY_CATEGORIES.map(c => [c, 0])
  ) as Record<DisplayCategory, number>

  for (const tx of txs) {
    if (!isSpending(tx.categoryPrimary)) continue
    // M5.5: if the merchant is a known subscription, override its natural category
    const merchant = (tx.cleanName ?? tx.name ?? "").toLowerCase()
    const display: DisplayCategory = subMerchants.has(merchant)
      ? "Subscriptions"
      : mapPlaidCategory(tx.categoryPrimary)
    buckets[display] += tx.amount.toNumber()
  }

  const total = Object.values(buckets).reduce((a, b) => a + b, 0)

  return DISPLAY_CATEGORIES
    .map(category => ({
      category,
      amount: Number(buckets[category].toFixed(2)),
      color: CATEGORY_COLORS[category],
      percentage: total > 0
        ? Number(((buckets[category] / total) * 100).toFixed(1))
        : 0,
    }))
    .filter(c => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)
}

// ── M5.2: New comparison endpoint data ───────────────────────────────
export async function fetchCategoryComparison(userId: string, months = 3) {
  const now = new Date()
  const out: Array<{ month: string; total: number; categories: Record<string, number> }> = []

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const spend = await fetchCategorySpend(userId, ym)
    const categories = Object.fromEntries(spend.map(s => [s.category, s.amount]))
    const total = spend.reduce((sum, s) => sum + s.amount, 0)
    out.push({ month: ym, total, categories })
  }
  return out
}

export interface MonthlyTotal {
  month:   string
  label:   string
  total:   number
  txCount: number
}

export async function fetchMonthlyTotals(userId: string, months: number = 12): Promise<MonthlyTotal[]> {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      deletedAt: null,
      pending:   false,
      amount:    { gt: 0 },
      date:      { gte: cutoff },
    },
    select: { date: true, amount: true },
  })

  const map: Record<string, { total: number; count: number }> = {}
  for (const tx of rows) {
    const key = tx.date.toISOString().slice(0, 7)
    if (!map[key]) map[key] = { total: 0, count: 0 }
    map[key].total += tx.amount.toNumber()
    map[key].count += 1
  }

  return Object.entries(map)
    .map(([month, { total, count }]) => ({
      month,
      label:   formatMonthLabel(month),
      total:   Math.round(total * 100) / 100,
      txCount: count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

function formatMonthLabel(yyyymm: string): string {
  const [year, month] = yyyymm.split('-')
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${names[parseInt(month) - 1]} ${year}`
}

// ── M3.3: Server-side search with filters ────────────────────────────
interface SearchFilters {
  q?:          string
  category?:   string
  dateFrom?:   string
  dateTo?:     string
  minAmount?:  number
  maxAmount?:  number
  tag?:        string
  sortBy?:     string
  limit?:      number
  offset?:     number
}

export async function searchTransactions(userId: string, filters: SearchFilters) {
  const where: any = { userId, deletedAt: null }

  if (filters.q) {
    const q = filters.q.trim()
    where.OR = [
      { cleanName:    { contains: q, mode: "insensitive" } },
      { merchantName: { contains: q, mode: "insensitive" } },
      { name:         { contains: q, mode: "insensitive" } },
      { notes:        { contains: q, mode: "insensitive" } },
    ]
  }

  if (filters.category) {
    where.categoryPrimary = filters.category
  }

  if (filters.dateFrom || filters.dateTo) {
    where.date = {}
    if (filters.dateFrom) where.date.gte = new Date(filters.dateFrom)
    if (filters.dateTo)   where.date.lte = new Date(filters.dateTo)
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    where.amount = {}
    if (filters.minAmount !== undefined) where.amount.gte = filters.minAmount
    if (filters.maxAmount !== undefined) where.amount.lte = filters.maxAmount
  }

  if (filters.tag) {
    where.tags = { has: filters.tag }
  }

  let orderBy: any = { date: "desc" }
  switch (filters.sortBy) {
    case "date-asc":    orderBy = { date: "asc" };   break
    case "amount-desc": orderBy = { amount: "desc" }; break
    case "amount-asc":  orderBy = { amount: "asc" };  break
  }

  const limit  = Math.min(filters.limit  ?? 100, 500)
  const offset = filters.offset ?? 0

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy, take: limit, skip: offset }),
    prisma.transaction.count({ where }),
  ])

  return { transactions, total, limit, offset }
}

export async function updateTransaction(
  transactionId: string,
  data: { tags?: string[]; notes?: string | null }
) {
  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      ...(data.tags  !== undefined && { tags:  data.tags }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  })
}