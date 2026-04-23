import prisma from "../lib/prisma"
import { fetchRecurring } from "./recurring.service"
import { mapPlaidCategory } from "../lib/categoryMap"

export type StreamKind = "subscription" | "bill" | "income"
export type Frequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "SEMI_MONTHLY" | "ANNUALLY" | "UNKNOWN"

export interface EnrichedStream {
  merchant: string
  cleanMerchant: string           // matched against transactions.cleanName
  kind: StreamKind
  category: string                // display category
  frequency: Frequency
  lastAmount: number
  lastDate: string                // YYYY-MM-DD
  monthlyAmount: number           // normalized to monthly cost
  source: "plaid" | "custom"      // where we detected it
  // Enrichments
  priceChange: { previousAmount: number; pctChange: number } | null
  isDuplicate: boolean            // same-merchant duplicate stream
  nextChargeDate: string | null   // YYYY-MM-DD or null
  daysUntilNextCharge: number | null
}

export interface SubscriptionAnalysis {
  subscriptions: EnrichedStream[]
  bills: EnrichedStream[]
  upcoming: EnrichedStream[]      // next 14 days, sorted
  alerts: Array<{ kind: "price_up" | "duplicate" | "many_streaming"; message: string }>
  totals: {
    monthlySubscriptions: number
    monthlyBills: number
    monthlyAll: number
  }
}

// — — — Frequency normalization — — —

const MONTHLY_MULTIPLIER: Record<Frequency, number> = {
  WEEKLY: 4.33, BIWEEKLY: 2.17, SEMI_MONTHLY: 2,
  MONTHLY: 1, ANNUALLY: 1 / 12, UNKNOWN: 1,
}
const DAYS_BETWEEN: Record<Frequency, number> = {
  WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15,
  MONTHLY: 30, ANNUALLY: 365, UNKNOWN: 30,
}

const normalizeMonthly = (amt: number, f: Frequency) =>
  Number((amt * MONTHLY_MULTIPLIER[f]).toFixed(2))

// — — — Classification — — —

const BILL_CATEGORIES = new Set([
  "Housing", "Bills & Utilities", "Debt",
])

function classifyStream(amount: number, category: string): StreamKind {
  // Income classified at the call site (negative amounts handled separately)
  if (BILL_CATEGORIES.has(category)) return "bill"
  if (amount >= 50) return "bill"   // big recurring charges = bills regardless
  return "subscription"
}

// — — — Custom detection — — —

// Strips spaces/dots/symbols so "Hbo Max" / "Hbomax" / "Help.Hbomax.Com" all key the same
function normalizeMerchant(raw: string): string {
  // Strip noise prefixes and TLDs, then collapse to alphanumeric lowercase.
  // Dedupes repeated tokens so "Help.Hbomax.Com Hbomax" → "hbomax" === "Hbo Max" → "hbomax"
  let cleaned = raw
    .replace(/\b(help|pay|payments?|www|http|https)\b/gi, "")
    .replace(/\.com\b|\.net\b|\.org\b|\.io\b/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
  // If string is a simple repetition (e.g. "hbomaxhbomax"), return the base unit
  const n = cleaned.length
  for (let l = 2; l <= Math.floor(n / 2); l++) {
    if (n % l === 0 && cleaned.slice(0, l).repeat(n / l) === cleaned) {
      return cleaned.slice(0, l)
    }
  }
  return cleaned
}

interface DetectionCandidate {
  cleanMerchant: string
  occurrences: Array<{ date: Date; amount: number; category: string | null }>
}

function detectCustomRecurring(
  txs: Array<{ date: Date; amount: number; category: string | null; cleanName: string | null; name: string | null }>,
  excludeMerchants: Set<string>,
): EnrichedStream[] {
  // Group by normalized key so variants like "Hbo Max" / "Hbomax" / "Help.Hbomax.Com" merge
  const groups = new Map<string, DetectionCandidate>()
  for (const tx of txs) {
    if (tx.amount <= 0) continue   // expenses only
    const rawMerchant = tx.cleanName ?? tx.name ?? "Unknown"
    const merchantKey = normalizeMerchant(rawMerchant)
    if (excludeMerchants.has(merchantKey)) continue
    const g = groups.get(merchantKey) ?? { cleanMerchant: rawMerchant, occurrences: [] }
    // Prefer the shortest display name (e.g. "Hbo Max" over "Help.Hbomax.Com Hbomax")
    if (rawMerchant.length < g.cleanMerchant.length) g.cleanMerchant = rawMerchant
    g.occurrences.push({ date: tx.date, amount: tx.amount, category: tx.category })
    groups.set(merchantKey, g)
  }

  const out: EnrichedStream[] = []
  for (const g of groups.values()) {
    if (g.occurrences.length < 3) continue

    // Sort by date asc
    g.occurrences.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Compute gaps in days
    const gaps: number[] = []
    for (let i = 1; i < g.occurrences.length; i++) {
      gaps.push((g.occurrences[i].date.getTime() - g.occurrences[i - 1].date.getTime()) / 86400000)
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const std = Math.sqrt(gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length)
    if (avgGap < 7 || avgGap > 32 || std > 7) continue

    // Amount consistency: ±20% of mean
    const amts = g.occurrences.map(o => o.amount)
    const avgAmt = amts.reduce((a, b) => a + b, 0) / amts.length
    const within = amts.every(a => Math.abs(a - avgAmt) / avgAmt <= 0.2)
    if (!within) continue

    // Frequency from average gap
    const freq: Frequency =
      avgGap <= 8 ? "WEEKLY" :
      avgGap <= 16 ? "BIWEEKLY" :
      "MONTHLY"

    const last = g.occurrences[g.occurrences.length - 1]
    const display = mapPlaidCategory(last.category)
    const kind = classifyStream(last.amount, display)

    out.push({
      merchant: g.cleanMerchant,
      cleanMerchant: g.cleanMerchant,
      kind,
      category: display,
      frequency: freq,
      lastAmount: Number(last.amount.toFixed(2)),
      lastDate: last.date.toISOString().slice(0, 10),
      monthlyAmount: normalizeMonthly(last.amount, freq),
      source: "custom",
      priceChange: null,         // filled in later
      isDuplicate: false,
      nextChargeDate: null,
      daysUntilNextCharge: null,
    })
  }

  return out
}

// — — — Price change — — —

function computePriceChange(
  stream: EnrichedStream,
  txsByMerchant: Map<string, Array<{ date: Date; amount: number }>>,
) {
  const matches = txsByMerchant.get(stream.cleanMerchant.toLowerCase())
  if (!matches || matches.length < 2) return null
  const sorted = [...matches].sort((a, b) => b.date.getTime() - a.date.getTime())
  const [latest, prev] = sorted
  if (prev.amount === 0) return null
  const pct = ((latest.amount - prev.amount) / prev.amount) * 100
  if (Math.abs(pct) < 5) return null
  return {
    previousAmount: Number(prev.amount.toFixed(2)),
    pctChange: Number(pct.toFixed(1)),
  }
}

// — — — Next charge prediction — — —

function predictNextCharge(stream: EnrichedStream, today: Date) {
  const last = new Date(stream.lastDate + "T00:00:00")
  const next = new Date(last)
  next.setDate(next.getDate() + DAYS_BETWEEN[stream.frequency])
  if (next < today) {
    // Past-due / missed — keep advancing until in the future
    while (next < today) next.setDate(next.getDate() + DAYS_BETWEEN[stream.frequency])
  }
  const days = Math.round((next.getTime() - today.getTime()) / 86400000)
  return {
    nextChargeDate: next.toISOString().slice(0, 10),
    daysUntilNextCharge: days,
  }
}

// — — — Main entry — — —

export async function fetchSubscriptionAnalysis(
  userId: string,
  plaidClient: any,                 // PlaidApi
): Promise<SubscriptionAnalysis> {
  const now = new Date()
  const ninetyAgo = new Date(now); ninetyAgo.setDate(ninetyAgo.getDate() - 90)

  // 1. Pull Plaid recurring streams (existing service)
  const plaidData = await fetchRecurring(plaidClient, userId)
  const plaidStreams: EnrichedStream[] = []

  for (const s of plaidData.outflow ?? []) {
    if (!s.is_active) continue
    const merchant = s.merchant_name ?? s.description ?? "Unknown"
    const category = mapPlaidCategory(
      s.personal_finance_category?.primary ?? null
    )
    const freq = (s.frequency as Frequency) ?? "MONTHLY"
    const lastAmount = Math.abs(Number(s.last_amount?.amount ?? 0))
    const lastDate = s.last_date ?? now.toISOString().slice(0, 10)

    plaidStreams.push({
      merchant, cleanMerchant: merchant,
      kind: classifyStream(lastAmount, category),
      category, frequency: freq, lastAmount, lastDate,
      monthlyAmount: normalizeMonthly(lastAmount, freq),
      source: "plaid",
      priceChange: null, isDuplicate: false,
      nextChargeDate: null, daysUntilNextCharge: null,
    })
  }

  // 2. Pull recent transactions for custom detection + enrichment
  const txs = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, date: { gte: ninetyAgo } },
    select: { date: true, amount: true, categoryPrimary: true, cleanName: true, name: true },
  })

  // Convert Decimal amounts + remap categoryPrimary → category for internal use
  const txsNormalized = txs.map(tx => ({
    date: tx.date,
    amount: tx.amount.toNumber(),
    category: tx.categoryPrimary,
    cleanName: tx.cleanName,
    name: tx.name,
  }))

  // 3. Custom detection — exclude merchants already in Plaid streams
  const plaidMerchants = new Set(plaidStreams.map(s => normalizeMerchant(s.merchant)))
  const customStreams = detectCustomRecurring(txsNormalized, plaidMerchants)

  // 4. Merge streams
  const allStreams = [...plaidStreams, ...customStreams]

  // 5. Build merchant lookup for price-change enrichment
  const txsByMerchant = new Map<string, Array<{ date: Date; amount: number }>>()
  for (const tx of txsNormalized) {
    if (tx.amount <= 0) continue
    const m = normalizeMerchant(tx.cleanName ?? tx.name ?? "")
    const arr = txsByMerchant.get(m) ?? []
    arr.push({ date: tx.date, amount: tx.amount })
    txsByMerchant.set(m, arr)
  }

  // 6. Enrich each stream
  for (const s of allStreams) {
    s.priceChange = computePriceChange(s, txsByMerchant)
    const next = predictNextCharge(s, now)
    s.nextChargeDate = next.nextChargeDate
    s.daysUntilNextCharge = next.daysUntilNextCharge
  }

  // 7. Duplicate detection — same merchant appearing twice
  const merchantCounts = new Map<string, number>()
  for (const s of allStreams) {
    const k = s.merchant.toLowerCase()
    merchantCounts.set(k, (merchantCounts.get(k) ?? 0) + 1)
  }
  for (const s of allStreams) {
    if ((merchantCounts.get(s.merchant.toLowerCase()) ?? 0) > 1) s.isDuplicate = true
  }

  // 8. Split + sort
  const subscriptions = allStreams
    .filter(s => s.kind === "subscription")
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
  const bills = allStreams
    .filter(s => s.kind === "bill")
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)

  // 9. Upcoming (next 14 days)
  const upcoming = allStreams
    .filter(s => s.daysUntilNextCharge !== null && s.daysUntilNextCharge <= 14)
    .sort((a, b) => (a.daysUntilNextCharge ?? 99) - (b.daysUntilNextCharge ?? 99))

  // 10. Alerts
  const alerts: SubscriptionAnalysis["alerts"] = []
  for (const s of allStreams) {
    if (s.priceChange && s.priceChange.pctChange > 0) {
      alerts.push({
        kind: "price_up",
        message: `${s.merchant} charged $${s.lastAmount.toFixed(2)} — up from $${s.priceChange.previousAmount.toFixed(2)} (+${s.priceChange.pctChange.toFixed(0)}%).`,
      })
    }
    if (s.isDuplicate) {
      alerts.push({
        kind: "duplicate",
        message: `${s.merchant} appears as multiple recurring streams. Possible duplicate billing.`,
      })
    }
  }
  // Streaming pile-up
  const streaming = subscriptions.filter(s => s.category === "Entertainment")
  if (streaming.length >= 3) {
    const total = streaming.reduce((sum, s) => sum + s.monthlyAmount, 0)
    alerts.push({
      kind: "many_streaming",
      message: `${streaming.length} streaming subscriptions — ${streaming.map(s => s.merchant).join(", ")}. Combined: $${total.toFixed(0)}/mo.`,
    })
  }

  // 11. Totals
  const monthlySubscriptions = Number(
    subscriptions.reduce((s, x) => s + x.monthlyAmount, 0).toFixed(2)
  )
  const monthlyBills = Number(
    bills.reduce((s, x) => s + x.monthlyAmount, 0).toFixed(2)
  )

  return {
    subscriptions, bills, upcoming, alerts,
    totals: {
      monthlySubscriptions,
      monthlyBills,
      monthlyAll: Number((monthlySubscriptions + monthlyBills).toFixed(2)),
    },
  }
}

// — — — Helper for M5.2 category override — — —

export async function getSubscriptionMerchants(
  userId: string,
  plaidClient: any,
): Promise<Set<string>> {
  const analysis = await fetchSubscriptionAnalysis(userId, plaidClient)
  return new Set(
    analysis.subscriptions.map(s => s.cleanMerchant.toLowerCase())
  )
}