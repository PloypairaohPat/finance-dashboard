import prisma from '../lib/prisma'
import {
  mapPlaidCategory, labelForPrimary, isSpending,
  CATEGORY_COLORS, DISPLAY_CATEGORIES,
  type DisplayCategory,
} from "../lib/categoryMap"
import { filterInternalTransfers } from "../utils/transferFilter"
import { getSubscriptionMerchants } from "./subscriptions.service"
import { plaidClient } from "../lib/plaidClient"
import { logoUrlFor } from "../lib/merchantLogos"

export async function fetchTransactions(userId: string) {
  return prisma.transaction.findMany({
    where:   { userId, deletedAt: null },
    orderBy: { date: 'desc' },
    take:    200,
  })
}

export async function fetchCategorySpend(userId: string, month?: string) {
  const now = new Date()
  const ym = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const [yr, mo] = ym.split("-").map(Number)
  const start = new Date(Date.UTC(yr, mo - 1, 1))
  const end   = new Date(Date.UTC(yr, mo, 1))

  // Fetch all transactions for the month (both legs needed for pair-match in Tier 2)
  const [allTxsRaw, rawAccounts, plaidItems] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, date: { gte: start, lt: end } },
      select: { id: true, amount: true, categoryPrimary: true, cleanName: true, name: true, accountId: true, date: true },
    }),
    prisma.account.findMany({ where: { userId }, select: { id: true } }),
    prisma.plaidItem.findMany({ where: { userId }, select: { institutionName: true } }),
  ])

  const userAccountIds = new Set(rawAccounts.map(a => a.id))
  const linkedInstitutionNames = plaidItems.map(i => i.institutionName).filter(Boolean) as string[]
  const allNums = allTxsRaw.map(tx => ({ ...tx, amount: tx.amount.toNumber() }))

  const { internalIds, soloCount, pairedCount } = await filterInternalTransfers(
    userId, allNums, userAccountIds, linkedInstitutionNames,
  )
  if (soloCount > 0 || pairedCount > 0) {
    console.log(`🔁 [breakdown] filtered ${soloCount} solo (counterparty), ${pairedCount} paired`)
  }

  // Only positive-amount, non-internal transactions feed the spending buckets
  const txs = allNums.filter(tx => tx.amount > 0 && !internalIds.has(tx.id))

  let subMerchants: Set<string>
  try {
    subMerchants = await getSubscriptionMerchants(userId, plaidClient)
  } catch (err) {
    console.warn("Subscription override unavailable, falling back:", err)
    subMerchants = new Set()
  }

  const buckets: Record<DisplayCategory, number> = Object.fromEntries(
    DISPLAY_CATEGORIES.map(c => [c, 0])
  ) as Record<DisplayCategory, number>

  for (const tx of txs) {
    if (!isSpending(tx.categoryPrimary)) continue
    const merchant = (tx.cleanName ?? tx.name ?? "").toLowerCase()
    const display: DisplayCategory = subMerchants.has(merchant)
      ? "Subscriptions"
      : mapPlaidCategory(tx.categoryPrimary)
    buckets[display] += tx.amount
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

// ── M5.7 Step 2: Search with cursor pagination + enrichment ──────────

export interface SearchParams {
  q?:          string
  category?:   string
  dateFrom?:   string
  dateTo?:     string
  minAmount?:  number
  maxAmount?:  number
  tags?:       string[]
  cursor?:     string
  limit?:      number
}

export interface EnrichedTransaction {
  id:          string
  name:        string
  displayName: string
  amount:      number
  date:        string
  category:    string
  rawCategory: string | null
  color:       string
  logoUrl:     string | null
  tags:        string[]
  notes:       string | null
  account:     string
}

export interface SearchResult {
  transactions: EnrichedTransaction[]
  nextCursor:   string | null
  totalCount:   number | null
}

export async function searchTransactions(
  userId: string,
  params: SearchParams,
): Promise<SearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)

  const where: any = { userId, deletedAt: null }

  if (params.q) {
    where.OR = [
      { cleanName: { contains: params.q, mode: "insensitive" } },
      { name:      { contains: params.q, mode: "insensitive" } },
    ]
  }

  if (params.dateFrom)
    where.date = { ...(where.date ?? {}), gte: new Date(params.dateFrom + "T00:00:00Z") }
  if (params.dateTo)
    where.date = { ...(where.date ?? {}), lt: new Date(new Date(params.dateTo + "T00:00:00Z").getTime() + 86400000) }

  if (params.minAmount !== undefined)
    where.amount = { ...(where.amount ?? {}), gte: params.minAmount }
  if (params.maxAmount !== undefined)
    where.amount = { ...(where.amount ?? {}), lte: params.maxAmount }

  if (params.tags && params.tags.length > 0)
    where.tags = { hasSome: params.tags }

  const wantsCategory = params.category && params.category !== "All"
  const fetchLimit = wantsCategory ? limit * 3 : limit + 1

  const rows = await prisma.transaction.findMany({
    where,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: fetchLimit,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: { account: { select: { name: true } } },
  })

  const filtered = wantsCategory
    ? rows.filter(r => mapPlaidCategory(r.categoryPrimary) === params.category)
    : rows

  const pageRows = filtered.slice(0, limit)
  const hasMore  = filtered.length > limit || (wantsCategory && rows.length === fetchLimit)
  const nextCursor = hasMore && pageRows.length > 0
    ? pageRows[pageRows.length - 1].id
    : null

  const transactions: EnrichedTransaction[] = pageRows.map(r => {
    const bucket  = mapPlaidCategory(r.categoryPrimary)   // for color lookup
    const label   = labelForPrimary(r.categoryPrimary)    // for badge display
    const merchant = r.cleanName ?? r.name ?? "Unknown"
    return {
      id:          r.id,
      name:        r.name ?? "Unknown",
      displayName: merchant,
      amount:      Number(Number(r.amount).toFixed(2)),
      date:        r.date.toISOString().slice(0, 10),
      category:    label,
      rawCategory: r.categoryPrimary ?? null,
      color:       CATEGORY_COLORS[bucket] ?? "#5a7a5a",
      logoUrl:     logoUrlFor(merchant),
      tags:        r.tags ?? [],
      notes:       r.notes ?? null,
      account:     r.account?.name ?? "",
    }
  })

  return { transactions, nextCursor, totalCount: null }
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  data: { tags?: string[]; notes?: string | null; category?: string }
) {
  const owned = await prisma.transaction.findFirst({
    where: { id: transactionId, userId },
    select: { id: true },
  })
  if (!owned) throw new Error("Transaction not found")

  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      ...(data.tags     !== undefined && { tags:            data.tags }),
      ...(data.notes    !== undefined && { notes:           data.notes }),
      ...(data.category !== undefined && { categoryPrimary: data.category }),
    },
  })
}

// ── M5.7 Step 4: Suggested tags endpoint ─────────────────────────────
export async function fetchUserTags(userId: string): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where:  { userId, deletedAt: null, tags: { isEmpty: false } },
    select: { tags: true },
  })
  const counts = new Map<string, number>()
  for (const r of rows) for (const t of (r.tags ?? [])) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => t)
}
