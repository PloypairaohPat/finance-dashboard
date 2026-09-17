import type { Prisma } from '@prisma/client'
import prisma from '../lib/prisma'
import {
  mapPlaidCategory, labelForPrimary,
  CATEGORY_COLORS,
  ASSIGNABLE_CATEGORIES, ASSIGNABLE_CATEGORY_CODES, isAssignableCategory,
  type DisplayCategory,
} from "../lib/categoryMap"
import { logoUrlFor } from "../lib/merchantLogos"
import {
  DEFAULT_PERIOD_START_DAY,
  fromDateKey,
  periodKeyOf,
  periodsFromFirstActivity,
  recentPeriods,
  type Period,
} from "../lib/period"
import { fetchFirstTransactionDate } from "./activity.service"
import {
  PAYMENTS_TO_PEOPLE, canRecategorise, describeVerdict,
  type Classified, type RowMeaning,
} from "../lib/classifier"
import { getPeriodStartDay } from "./user.service"
import { classifyWindow, spendByBucket, spendForPeriod } from "./classification.service"

export async function fetchTransactions(userId: string) {
  return prisma.transaction.findMany({
    where:   { userId, deletedAt: null },
    orderBy: { date: 'desc' },
    take:    200,
  })
}

// GET /categories — the Overview "Spending breakdown" — for the user's current
// money period, with the period so the panel can label it and say "so far".
// It sits beside Month over month, so it must use the same window (M7.2 Q1).
export async function fetchCurrentPeriodCategorySpend(
  userId: string,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
) {
  const [period] = recentPeriods(now, startDay, 1)
  const categories = await fetchCategorySpend(
    userId,
    { start: fromDateKey(period.start), end: fromDateKey(period.end) },
    startDay,
  )
  return { categories, period }
}

// Category spend within one money period. Without a window it uses the user's
// current period; every caller in the app passes one explicitly.
export async function fetchCategorySpend(
  userId: string,
  window?: { start: Date; end: Date },
  startDay: number = DEFAULT_PERIOD_START_DAY,
) {
  // The classifier buckets by money period, so the window has to BE a period.
  // Every caller passes one; without a window, use the user's current period.
  let start: Date, end: Date
  if (window) {
    ({ start, end } = window)
  } else {
    const [current] = recentPeriods(new Date(), startDay, 1)
    start = fromDateKey(current.start)
    end = fromDateKey(current.end)
  }

  const { rows, paymentAppByPeriod } = await classifyWindow(userId, { since: start, until: end, startDay })
  const periodKey = periodKeyOf(start, startDay)
  const buckets = spendByBucket(rows, periodKey, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
  const total = Object.values(buckets).reduce((a, b) => a + b, 0)

  return Object.entries(buckets)
    .filter(([, amount]) => amount !== 0)
    .map(([category, amount]) => ({
      category,
      amount: Number(amount.toFixed(2)),
      color: CATEGORY_COLORS[category as DisplayCategory] ?? "#5a7a5a",
      percentage: total > 0 ? Number(((amount / total) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
}

// Month over month, per money period (M7.2). Oldest first; the last entry is
// the current period and carries inProgress/dayOfPeriod so the UI can say
// "so far" instead of comparing a partial period as if it were complete.
export async function fetchCategoryComparison(
  userId: string,
  periodCount = 3,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
) {
  // Periods from before the user's first transaction are dropped (Q2): with
  // no history, "was $0" / "new" against a period they didn't exist in misleads.
  const periods = periodsFromFirstActivity(
    recentPeriods(now, startDay, periodCount),
    await fetchFirstTransactionDate(userId),
  )
  const out: Array<Period & { month: string; total: number; categories: Record<string, number> }> = []
  if (periods.length === 0) return out

  // One classified window for every period, rather than a query and a transfer
  // filter per period. Pairs that straddle a period boundary depend on it.
  const { rows, paymentAppByPeriod } = await classifyWindow(userId, {
    since: fromDateKey(periods[0].start),
    until: fromDateKey(periods[periods.length - 1].end),
    startDay,
  })

  for (const p of periods) {
    const buckets = spendByBucket(rows, p.key, startDay, paymentAppByPeriod, PAYMENTS_TO_PEOPLE)
    // A bucket can now be negative when refunds outweigh spending in it. That is
    // a real fact about the period, so it is shown rather than clipped to zero.
    const categories = Object.fromEntries(Object.entries(buckets).filter(([, v]) => v !== 0))
    const total = Math.round(Object.values(categories).reduce((s, v) => s + v, 0) * 100) / 100
    out.push({ ...p, month: p.key, total, categories })
  }
  return out
}

export interface MonthlyTotal extends Period {
  /** The period key, kept under its historical name. */
  month:   string
  total:   number
  txCount: number
}

// One entry per period, oldest first, including empty periods as zero (M7.2).
// Before M7.2 the cutoff was "exactly N months before today", so the oldest
// bucket was a partial month and plotted as an artificially low one; the
// window now starts on a period boundary.
export async function fetchMonthlyTotals(
  userId: string,
  periodCount: number = 12,
  startDay: number = DEFAULT_PERIOD_START_DAY,
  now: Date = new Date(),
): Promise<MonthlyTotal[]> {
  // Periods from before the user's first transaction are dropped (Q2); empty
  // periods after it stay as zeros. No transactions at all means no periods.
  const periods = periodsFromFirstActivity(
    recentPeriods(now, startDay, periodCount),
    await fetchFirstTransactionDate(userId),
  )
  if (periods.length === 0) return []

  const { rows: classified, paymentAppByPeriod } = await classifyWindow(userId, {
    since: fromDateKey(periods[0].start),
    until: fromDateKey(periods[periods.length - 1].end),
    startDay,
  })

  return periods.map((p) => ({
    ...p,
    month: p.key,
    total: spendForPeriod(classified, p.key, startDay, paymentAppByPeriod),
    // Counts the rows that make up the bar: spending and the refunds netted off
    // it. Transfers and card payments are no longer spending, so a period of
    // nothing but transfers is honestly an empty bar.
    txCount: classified.filter(
      (r) =>
        periodKeyOf(r.date, startDay) === p.key &&
        (r.verdict.kind === "spend" || r.verdict.kind === "refund"),
    ).length,
  }))
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
  /**
   * M7.3: what this row IS, from the classifier — the same verdict every total
   * uses. The list renders from this, not from the sign of the amount, so a card
   * payment stops showing as red spending while every total says it isn't.
   */
  meaning:     RowMeaning
  /**
   * The bucket every total counts this row under. `category` is Plaid's finer
   * badge label ("Loan Payment", "Personal Care"), which is not a display
   * category, so an editor must start from this field rather than that one.
   */
  displayCategory:  DisplayCategory
  /** Whether PATCH will accept a category change for this row (see canRecategorise). */
  categoryEditable: boolean
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

  const transactions = await enrichRows(userId, pageRows)
  return { transactions, nextCursor, totalCount: null }
}

type RowForEnrichment = Prisma.TransactionGetPayload<{ include: { account: { select: { name: true } } } }>

// Shared by the list and by PATCH, so a saved row comes back exactly as the list
// would show it — including a verdict recomputed from the codes just written.
async function enrichRows(userId: string, pageRows: RowForEnrichment[]): Promise<EnrichedTransaction[]> {
  // Classify the page's date range. classifyWindow pads either side, so a card
  // payment on the last row of this page still finds its partner on the next.
  const verdicts = new Map<string, Classified>()
  if (pageRows.length > 0) {
    const dates = pageRows.map(r => r.date.getTime())
    const startDay = await getPeriodStartDay(userId)
    const { rows: classified } = await classifyWindow(userId, {
      since: new Date(Math.min(...dates)),
      until: new Date(Math.max(...dates) + 86_400_000),
      startDay,
    })
    for (const c of classified) verdicts.set(c.id, c.verdict)
  }

  return pageRows.map(r => {
    const bucket  = mapPlaidCategory(r.categoryPrimary)   // for color lookup
    const label   = labelForPrimary(r.categoryPrimary)    // for badge display
    const merchant = r.cleanName ?? r.name ?? "Unknown"
    const verdict = verdicts.get(r.id)
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
      // Every page row is inside the classified range, so this always resolves;
      // the fallback exists only so a gap fails visibly rather than as a crash.
      meaning:     verdict ? describeVerdict(verdict) : { kind: "unclassified_inflow", label: "Unclassified" },
      displayCategory:  bucket,
      categoryEditable: verdict ? canRecategorise(verdict, r.categoryDetailed) : false,
    }
  })
}

/** A PATCH the caller got wrong, with the HTTP status that says how. */
export class TransactionUpdateError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  data: { tags?: string[]; notes?: string | null; category?: unknown }
): Promise<EnrichedTransaction> {
  const existing = await prisma.transaction.findFirst({
    where: { id: transactionId, userId },
    include: { account: { select: { name: true } } },
  })
  if (!existing) throw new TransactionUpdateError(404, "Transaction not found")

  // A category arrives as a DISPLAY name and is stored as the Plaid codes that map
  // back to it (ASSIGNABLE_CATEGORY_CODES). Unchanged is not an edit: the row keeps
  // Plaid's own, more specific codes.
  let codes: { categoryPrimary: string | null; categoryDetailed: string | null } | null = null
  if (data.category !== undefined) {
    if (!isAssignableCategory(data.category)) {
      throw new TransactionUpdateError(
        400,
        `Unknown category ${JSON.stringify(data.category)}. Expected one of: ${ASSIGNABLE_CATEGORIES.join(", ")}`,
      )
    }
    const [current] = await enrichRows(userId, [existing])
    if (data.category !== current.displayCategory) {
      if (!current.categoryEditable) {
        throw new TransactionUpdateError(
          409,
          `This transaction is counted as "${current.meaning.label}", so its category doesn't decide any total and can't be changed.`,
        )
      }
      const target = ASSIGNABLE_CATEGORY_CODES[data.category]
      codes = { categoryPrimary: target.primary, categoryDetailed: target.detailed }
    }
  }

  const updated = await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      ...(data.tags     !== undefined && { tags:  data.tags }),
      ...(data.notes    !== undefined && { notes: data.notes }),
      ...(codes ?? {}),
    },
    include: { account: { select: { name: true } } },
  })
  const [enriched] = await enrichRows(userId, [updated])
  return enriched
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
