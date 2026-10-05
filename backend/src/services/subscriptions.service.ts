import type { PlaidApi } from "plaid"
import prisma from "../lib/prisma"
import { fetchRecurring } from "./recurring.service"
import { mapPlaidCategory } from "../lib/categoryMap"
import { classifyWindow } from "./classification.service"
import { getPeriodStartDay } from "./user.service"
import { merchantIdentity, normalizeMerchant } from "../lib/merchantIdentity"
import { walkSeries, type Period } from "../lib/subscriptionSeries"

export type StreamKind = "subscription" | "bill" | "income"
export type Frequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "SEMI_MONTHLY" | "ANNUALLY" | "UNKNOWN"

export interface EnrichedStream {
  merchant: string
  cleanMerchant: string           // matched against transactions.cleanName
  /**
   * The grouping key: merchantIdentity (lib/merchantIdentity) — Plaid's entity
   * id where the rule allows one, else the normalised name. Stable across
   * display-name variants, unlike `merchant`, which is the SHORTEST name in the
   * group and so can change when a new variant arrives. Key anything that must
   * stay the same across runs — an alert fingerprint, a price lookup — on this.
   */
  key: string
  kind: StreamKind
  category: string                // display category
  frequency: Frequency
  lastAmount: number
  lastDate: string                // YYYY-MM-DD
  /** The last charge hasn't posted yet: shown as pending, and price-up waits for it. */
  lastChargePending: boolean
  monthlyAmount: number           // normalized to monthly cost
  source: "plaid" | "custom"      // where we detected it
  // Enrichments
  priceChange: { previousAmount: number; pctChange: number } | null
  isDuplicate: boolean            // same-merchant duplicate stream
  nextChargeDate: string | null   // YYYY-MM-DD or null
  daysUntilNextCharge: number | null
  /** The charges this stream is made of: what a mark and a detected stream are merged on. */
  txIds: string[]
  /** Set when the user marked it ("Mark as subscription"); the id un-marks it. */
  mark: { id: string } | null
  /**
   * "ended": a marked subscription whose last two slots passed with no charge.
   * Shown, but out of the totals, upcoming and alerts. Detected streams are
   * always "active": detection drops a stream that stops.
   */
  status: "active" | "ended"
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

interface DetectionCandidate {
  cleanMerchant: string
  occurrences: Array<{ id: string; date: Date; amount: number; category: string | null; pending: boolean }>
}

function detectCustomRecurring(txs: SpendRow[]): EnrichedStream[] {
  // Grouped by merchant identity, so one merchant's name variants ("Hbo Max",
  // "Help.Hbomax.Com Hbomax", or names Plaid ties to one entity id) are one group.
  const groups = new Map<string, DetectionCandidate>()
  for (const tx of txs) {
    if (tx.amount <= 0) continue   // expenses only
    const g = groups.get(tx.merchantKey) ?? { cleanMerchant: tx.merchantLabel, occurrences: [] }
    // Prefer the shortest display name (e.g. "Hbo Max" over "Help.Hbomax.Com Hbomax")
    if (tx.merchantLabel.length < g.cleanMerchant.length) g.cleanMerchant = tx.merchantLabel
    g.occurrences.push({ id: tx.id, date: tx.date, amount: tx.amount, category: tx.category, pending: tx.pending })
    groups.set(tx.merchantKey, g)
  }

  const out: EnrichedStream[] = []
  for (const [key, g] of groups) {
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
      key,
      kind,
      category: display,
      frequency: freq,
      lastAmount: Number(last.amount.toFixed(2)),
      lastDate: last.date.toISOString().slice(0, 10),
      lastChargePending: last.pending,
      monthlyAmount: normalizeMonthly(last.amount, freq),
      source: "custom",
      priceChange: null,         // filled in later
      isDuplicate: false,
      nextChargeDate: null,
      daysUntilNextCharge: null,
      txIds: g.occurrences.map(o => o.id),
      mark: null,
      status: "active",
    })
  }

  return out
}

// — — — Price change — — —

function computePriceChange(
  stream: EnrichedStream,
  txsByMerchant: Map<string, Array<{ date: Date; amount: number }>>,
) {
  // By the grouping key, which is what the map is keyed on. It used to look up
  // cleanMerchant.toLowerCase(), which only matches when normalizing changes
  // nothing — so any merchant with a space, punctuation or a ".com" in its name
  // ("Apple iCloud") never had a price change, and subscription_price_up could
  // not have fired for it even with the detector fixed.
  const matches = txsByMerchant.get(stream.key)
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
//
// Two analyses, one composed from the other (M7.3):
//
//   analyseStoredSubscriptions  — stored data only. What the bell reads: alert
//     detectors run when the bell opens and must not call Plaid.
//   fetchSubscriptionAnalysis   — the Subscriptions tab: the SAME stored
//     streams, plus any Plaid stream whose grouping key isn't already among
//     them. A stored stream is never dropped or renamed by the merge, so every
//     stream the bell can alert on is in the tab by construction.
//
// Stored streams are detected ones and marked ones ("Mark as subscription").
// A mark and a detected stream that share a charge are one subscription, shown
// as marked.
//
// The Plaid half has never produced a stream: fetchRecurring returns streams
// already mapped (merchantName, lastAmount, lastDate…), while the code below
// reads the raw Plaid fields (is_active, merchant_name, …), and `is_active` is
// always undefined. Recorded for M7.6, which replaces it.

const DAY_MS = 86_400_000
/** What detection reads. */
const DETECTION_DAYS = 90
/** How far back a marked subscription is followed: long enough to see an annual charge twice. */
const MARK_LOOKBACK_MONTHS = 13

/** Spend rows since `since`: all detection and marks read. */
async function loadSpendRows(userId: string, now: Date, since: Date) {
  // M7.3: a row the classifier does not call spending cannot become a
  // subscription, so a monthly transfer to savings or a card payment can't be
  // detected as a recurring "bill".
  const startDay = await getPeriodStartDay(userId)
  const { rows } = await classifyWindow(userId, { since, until: now, startDay })

  return rows
    .filter(row => row.verdict.kind === "spend")
    .map(row => ({
      id: row.id,
      date: row.date,
      amount: row.amount,
      category: row.categoryPrimary,
      merchantLabel: row.merchantLabel,
      merchantKey: row.merchantKey,
      pending: row.pending,
    }))
}

type SpendRow = Awaited<ReturnType<typeof loadSpendRows>>[number]

/** The user's marks, oldest first, each with its anchor's identity fields. */
function loadMarks(userId: string) {
  return prisma.subscriptionMark.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      transaction: {
        select: {
          id: true, date: true, amount: true, cleanName: true, name: true, categoryPrimary: true,
          merchantEntityId: true, counterpartyEntities: true,
        },
      },
    },
  })
}

type Mark = Awaited<ReturnType<typeof loadMarks>>[number]

const FREQUENCY_OF: Record<Period, Frequency> = {
  WEEKLY: "WEEKLY", BIWEEKLY: "BIWEEKLY", MONTHLY: "MONTHLY", ANNUALLY: "ANNUALLY",
}

/** Price change between a series' last two charges: at least 5% either way, as for detection. */
function seriesPriceChange(amounts: number[]) {
  if (amounts.length < 2) return null
  const [prev, latest] = amounts.slice(-2)
  if (prev === 0) return null
  const pct = ((latest - prev) / prev) * 100
  if (Math.abs(pct) < 5) return null
  return { previousAmount: Number(prev.toFixed(2)), pctChange: Number(pct.toFixed(1)) }
}

/**
 * One stream per mark: the anchor's merchant (its raw ids under the current
 * identity rule), and the charges walked from the anchor (lib/subscriptionSeries).
 */
function markedStreams(marks: Mark[], rows: SpendRow[], now: Date, since: Date): EnrichedStream[] {
  const out: EnrichedStream[] = []
  const claimed = new Set<string>()
  for (const m of marks) {
    const t = m.transaction
    const label = t.cleanName ?? t.name ?? "Unknown"
    const key = merchantIdentity({ merchantEntityId: t.merchantEntityId, counterpartyEntities: t.counterpartyEntities, label })
    const sameMerchant = rows.filter(r => r.merchantKey === key && r.amount > 0)
    const anchor = { id: t.id, date: t.date, amount: Number(t.amount) }
    const series = walkSeries(anchor, sameMerchant, { now, since })
    const ids = series.charges.map(c => c.id)
    // Two marks on one series (possible when the second was made before the
    // charges joining them existed): the older mark speaks for it.
    if (ids.some(id => claimed.has(id))) continue
    ids.forEach(id => claimed.add(id))

    const byId = new Map(sameMerchant.map(r => [r.id, r]))
    // Shown under the name of the charge the user marked: the one they recognised.
    const display = label
    const last = series.charges[series.charges.length - 1]
    const frequency: Frequency = series.period ? FREQUENCY_OF[series.period] : "UNKNOWN"
    const ended = series.ended
    out.push({
      merchant: display,
      cleanMerchant: display,
      key,
      // The user said it is a subscription; the amount-based bill split doesn't apply.
      kind: "subscription",
      category: mapPlaidCategory(byId.get(last.id)?.category ?? t.categoryPrimary),
      frequency,
      lastAmount: Number(last.amount.toFixed(2)),
      lastDate: last.date.toISOString().slice(0, 10),
      lastChargePending: byId.get(last.id)?.pending ?? false,
      // An unknown schedule has no monthly cost yet: an annual charge assumed
      // monthly would put a year's price into the monthly total.
      monthlyAmount: series.period ? normalizeMonthly(last.amount, frequency) : 0,
      source: "custom",
      priceChange: ended ? null : seriesPriceChange(series.charges.map(c => c.amount)),
      isDuplicate: false,
      nextChargeDate: null,
      daysUntilNextCharge: null,
      txIds: ids,
      mark: { id: m.id },
      status: ended ? "ended" : "active",
    })
  }
  return out
}

/** Every stream from stored data, plus the 90-day rows detection and price changes read. */
async function storedStreams(userId: string, now: Date) {
  const marks = await loadMarks(userId)
  const recentSince = new Date(now.getTime() - DETECTION_DAYS * DAY_MS)
  const markSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MARK_LOOKBACK_MONTHS, now.getUTCDate()))
  // The longer window only when there is a mark to follow through it.
  const since = marks.length > 0 && markSince < recentSince ? markSince : recentSince
  const rows = await loadSpendRows(userId, now, since)
  const recent = rows.filter(r => r.date >= recentSince)

  const marked = markedStreams(marks, rows, now, since)
  const inMarked = new Set(marked.flatMap(s => s.txIds))
  const detected = detectCustomRecurring(recent).filter(d => !d.txIds.some(id => inMarked.has(id)))
  return { streams: [...marked, ...detected], recent }
}

/** Plaid's recurring streams for the user. See the note above: today it returns none. */
async function plaidStreamsFor(userId: string, plaidClient: PlaidApi, now: Date): Promise<EnrichedStream[]> {
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
      merchant, cleanMerchant: merchant, key: normalizeMerchant(merchant),
      kind: classifyStream(lastAmount, category),
      category, frequency: freq, lastAmount, lastDate, lastChargePending: false,
      monthlyAmount: normalizeMonthly(lastAmount, freq),
      source: "plaid",
      priceChange: null, isDuplicate: false,
      nextChargeDate: null, daysUntilNextCharge: null,
      txIds: [], mark: null, status: "active",
    })
  }
  return plaidStreams
}

/** The bell's input: stored data only. No Plaid call, for real users or the demo. */
export async function analyseStoredSubscriptions(
  userId: string,
  now: Date = new Date(),
): Promise<SubscriptionAnalysis> {
  const { streams, recent } = await storedStreams(userId, now)
  return analyse(streams, recent, now)
}

/** The Subscriptions tab: the stored analysis's streams, with Plaid's merged in. */
export async function fetchSubscriptionAnalysis(
  userId: string,
  plaidClient: PlaidApi,
): Promise<SubscriptionAnalysis> {
  const now = new Date()
  const { streams, recent } = await storedStreams(userId, now)
  const storedKeys = new Set(streams.map(s => s.key))
  const plaid = (await plaidStreamsFor(userId, plaidClient, now)).filter(p => !storedKeys.has(p.key))
  return analyse([...streams, ...plaid], recent, now)
}

/** What counts toward totals and upcoming: running, on a known schedule. */
const isCounted = (s: EnrichedStream) => s.status === "active" && s.frequency !== "UNKNOWN"

/** Steps 5–11 over a set of streams: price change, next charge, duplicates, split, alerts, totals. */
function analyse(allStreams: EnrichedStream[], txsNormalized: SpendRow[], now: Date): SubscriptionAnalysis {
  // 5. Build merchant lookup for price-change enrichment
  const txsByMerchant = new Map<string, Array<{ date: Date; amount: number }>>()
  for (const tx of txsNormalized) {
    if (tx.amount <= 0) continue
    const arr = txsByMerchant.get(tx.merchantKey) ?? []
    arr.push({ date: tx.date, amount: tx.amount })
    txsByMerchant.set(tx.merchantKey, arr)
  }

  // 6. Enrich each stream. A marked stream's price change comes from its own
  //    series — the merchant's other charges may be a different subscription.
  for (const s of allStreams) {
    if (!s.mark) s.priceChange = computePriceChange(s, txsByMerchant)
    if (!isCounted(s)) continue
    const next = predictNextCharge(s, now)
    s.nextChargeDate = next.nextChargeDate
    s.daysUntilNextCharge = next.daysUntilNextCharge
  }

  // 7. Duplicate detection — same merchant appearing twice. Not for marks: a
  //    user who marked two series of one merchant has said they are two.
  const merchantCounts = new Map<string, number>()
  for (const s of allStreams) {
    if (s.mark) continue
    const k = s.merchant.toLowerCase()
    merchantCounts.set(k, (merchantCounts.get(k) ?? 0) + 1)
  }
  for (const s of allStreams) {
    if (!s.mark && (merchantCounts.get(s.merchant.toLowerCase()) ?? 0) > 1) s.isDuplicate = true
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
    if (s.status === "ended") continue
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
  const streaming = subscriptions.filter(s => s.category === "Entertainment" && isCounted(s))
  if (streaming.length >= 3) {
    const total = streaming.reduce((sum, s) => sum + s.monthlyAmount, 0)
    alerts.push({
      kind: "many_streaming",
      message: `${streaming.length} streaming subscriptions — ${streaming.map(s => s.merchant).join(", ")}. Combined: $${total.toFixed(0)}/mo.`,
    })
  }

  // 11. Totals: ended subscriptions and unknown schedules add nothing.
  const monthlySubscriptions = Number(
    subscriptions.filter(isCounted).reduce((s, x) => s + x.monthlyAmount, 0).toFixed(2)
  )
  const monthlyBills = Number(
    bills.filter(isCounted).reduce((s, x) => s + x.monthlyAmount, 0).toFixed(2)
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
