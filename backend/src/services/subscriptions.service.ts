// ─────────────────────────────────────────────────────────────────
//  subscriptions.service — the shared pieces of the Subscriptions tab's
//  analysis. The tab, the bell and the transaction panel read
//  composeSubscriptions (streamComposition.service): Plaid's stored recurring
//  streams, sorted by one definition, plus the user's verdicts. This module
//  holds what that composition is built from:
//
//    - the result's types (EnrichedStream, SubscriptionAnalysis)
//    - marks: loadMarks, and markedStreams, which follows a confirmation on a
//      charge in no stream as a series from its anchor (lib/subscriptionSeries)
//    - loadSpendRows, the classified spend rows a marked series is walked over
//    - predictNextCharge and seriesPriceChange
//    - finishAnalysis: duplicates, the split into subscriptions and bills,
//      upcoming, alerts and totals
//
//  Stored data only: nothing here calls Plaid. Our own recurring-charge
//  detector lived here until M7.6 PR 5f deleted it; Plaid's streams replaced it.
// ─────────────────────────────────────────────────────────────────

import prisma from "../lib/prisma"
import { mapPlaidCategory } from "../lib/categoryMap"
import { classifyWindow } from "./classification.service"
import { getPeriodStartDay } from "./user.service"
import { merchantIdentity } from "../lib/merchantIdentity"
import { walkSeries, type Period } from "../lib/subscriptionSeries"
import { monthlyAmount } from "../lib/monthlyAmount"

export type StreamKind = "subscription" | "bill"
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
  source: "plaid" | "custom"      // "plaid": one of Plaid's streams; "custom": a marked series
  // Enrichments
  priceChange: { previousAmount: number; pctChange: number } | null
  isDuplicate: boolean            // same-merchant duplicate stream
  nextChargeDate: string | null   // YYYY-MM-DD or null
  daysUntilNextCharge: number | null
  /** The charges this stream is made of: what a mark and a detected stream are merged on. */
  txIds: string[]
  /**
   * For a Plaid stream: the charge Confirm and Dismiss anchor on — its newest
   * posted, live one, which stays with the part still running when Plaid
   * regroups or splits it. null when none has posted yet.
   */
  anchorTxId?: string | null
  /** Set when the user marked or confirmed it; the id un-marks it. */
  mark: { id: string } | null
  /**
   * A confirmation that no longer counts: none of its charges is live
   * spending today. "not-spending": its charge is now a transfer or other
   * non-spending money. "removed": the bank removed it. Shown where the user
   * put it, outside every total, and still removable.
   */
  notCounted?: { reason: "not-spending" | "removed" }
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

const DAYS_BETWEEN: Record<Frequency, number> = {
  WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15,
  MONTHLY: 30, ANNUALLY: 365, UNKNOWN: 30,
}

// — — — Next charge prediction — — —

export function predictNextCharge(stream: EnrichedStream, today: Date) {
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

// — — — Marks — — —

/** How far back a marked subscription is followed: long enough to see an annual charge twice. */
export const MARK_LOOKBACK_MONTHS = 13

/** Classified spend rows since `since`: what a marked series is walked over. */
export async function loadSpendRows(userId: string, now: Date, since: Date) {
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

export type SpendRow = Awaited<ReturnType<typeof loadSpendRows>>[number]

/** The user's marks, oldest first, each with its anchor's identity fields. Confirmations only. */
export function loadMarks(userId: string) {
  return prisma.subscriptionMark.findMany({
    where: { userId, kind: "confirmed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      transaction: {
        select: {
          id: true, date: true, amount: true, cleanName: true, name: true, categoryPrimary: true,
          merchantEntityId: true, counterpartyEntities: true, deletedAt: true,
        },
      },
    },
  })
}

export type Mark = Awaited<ReturnType<typeof loadMarks>>[number]

const FREQUENCY_OF: Record<Period, Frequency> = {
  WEEKLY: "WEEKLY", BIWEEKLY: "BIWEEKLY", MONTHLY: "MONTHLY", ANNUALLY: "ANNUALLY",
}

/** Price change between a series' last two charges: at least 5% either way, as for detection. */
export function seriesPriceChange(amounts: number[]) {
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
 *
 * `rows` are the user's live spending rows, pending included, reaching back to
 * the oldest anchor. Only those charges feed anything: dates from the newest of
 * them, pending or not; amounts and the price change from the posted ones. An
 * anchor that is removed, or no longer spending, feeds neither; a series left
 * with no such charge is notCounted, shown where the user put it, out of every total.
 */
export function markedStreams(
  marks: Mark[], rows: SpendRow[], now: Date, since: Date,
  /** Charges already shown by something else: a series that reaches one is left out. */
  claimed: Set<string> = new Set(),
): EnrichedStream[] {
  const out: EnrichedStream[] = []
  const rowOf = new Map(rows.map(r => [r.id, r]))
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

    // Shown under the name of the charge the user marked: the one they recognised.
    const display = label
    const frequency: Frequency = series.period ? FREQUENCY_OF[series.period] : "UNKNOWN"
    const ended = series.ended
    // Live spending charges set dates; the posted ones among them set amounts.
    const usable = series.charges.filter(c => rowOf.has(c.id))
    const posted = usable.filter(c => !rowOf.get(c.id)!.pending)
    const stale = usable.length === 0
    const last = stale ? series.charges[series.charges.length - 1] : usable[usable.length - 1]
    const lastPosted = posted[posted.length - 1] ?? last
    out.push({
      merchant: display,
      cleanMerchant: display,
      key,
      // The user said it is a subscription; the amount-based bill split doesn't apply.
      kind: "subscription",
      category: mapPlaidCategory(rowOf.get(last.id)?.category ?? t.categoryPrimary),
      frequency,
      lastAmount: Number(lastPosted.amount.toFixed(2)),
      lastDate: last.date.toISOString().slice(0, 10),
      lastChargePending: rowOf.get(last.id)?.pending ?? false,
      // The one monthly-amount definition (lib/monthlyAmount): a subscription's
      // last posted charge, per frequency. An unknown schedule has none yet (0):
      // an annual charge assumed monthly would put a year's price into the total.
      monthlyAmount: monthlyAmount("subscription", posted.map(c => c.amount), frequency) ?? 0,
      source: "custom",
      priceChange: ended ? null : seriesPriceChange(posted.map(c => c.amount)),
      isDuplicate: false,
      nextChargeDate: null,
      daysUntilNextCharge: null,
      txIds: ids,
      mark: { id: m.id },
      status: ended ? "ended" : "active",
      ...(stale && { notCounted: { reason: t.deletedAt ? "removed" as const : "not-spending" as const } }),
    })
  }
  return out
}

/** What counts toward totals and upcoming: running, on a known schedule. */
export const isCounted = (s: EnrichedStream) => s.status === "active" && s.frequency !== "UNKNOWN" && !s.notCounted

/**
 * The composition's last steps (streamComposition.service): duplicates, the
 * split into subscriptions and bills, upcoming, alerts and totals. Price change
 * and next charge are already set.
 */
export function finishAnalysis(allStreams: EnrichedStream[]): SubscriptionAnalysis {
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
