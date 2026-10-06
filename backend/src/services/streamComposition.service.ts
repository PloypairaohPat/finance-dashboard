// ─────────────────────────────────────────────────────────────────
//  streamComposition.service — the Subscriptions tab and the bell, built from
//  stored Plaid streams and the user's verdicts (M7.6 PR 5).
//
//  Reads stored data only: never a Plaid call. Not wired to any endpoint
//  until PR 5e; scripts/stream-composition-audit.ts previews it.
//
//  The result is the sorting (lib/streamSorting) plus verdicts (marks):
//
//    - A stream's verdict is the LATEST one on any of its charges, so a
//      stream Plaid regroups takes the newest answer about any of its parts.
//    - Confirmed: shown in its bucket — a subscription or bill as sorted, else
//      where it lands once confirmed (confirmsAs). Counted when active with a
//      known frequency; shown as ended when inactive, which overrides
//      ended-unconfirmed.
//    - Dismissed: not shown; listed under `dismissed` so it can be restored.
//    - No verdict: subscriptions and bills shown; suggestions listed apart,
//      outside every total; everything hidden stays hidden.
//    - A confirmation on a charge in no stream (or only in a stream the
//      sorting hides for any reason but ended-unconfirmed) is today's mark:
//      its series is walked from the anchor (lib/subscriptionSeries).
//
//  No charge is shown twice. Items claim their charges in this order, and an
//  item reaching a charge already claimed is folded into the one that has it:
//    1. confirmed streams, latest verdict first
//    2. marks walked as series (the gym under four names: a stream Plaid
//       forms from some of its charges folds into the marked series)
//    3. other subscription and bill streams
//    4. suggestions
// ─────────────────────────────────────────────────────────────────

import type { MarkKind } from '@prisma/client'
import prisma from '../lib/prisma'
import { mapPlaidCategory } from '../lib/categoryMap'
import { monthlyAmount } from '../lib/monthlyAmount'
import { readFrequency } from '../lib/recurringStreams'
import type { SortReason } from '../lib/streamSorting'
import { sortUserStreams, type SortedStream } from './streamSorting.service'
import {
  MARK_LOOKBACK_MONTHS, finishAnalysis, isCounted, loadMarks, loadSpendRows, markedStreams, predictNextCharge,
  seriesPriceChange, type EnrichedStream, type Frequency, type SubscriptionAnalysis,
} from './subscriptions.service'

const DAY_MS = 86_400_000

export interface SuggestedStream extends EnrichedStream {
  /** Where it lands once confirmed. */
  confirmsAs: 'subscription' | 'bill'
  /** Plaid's EARLY_DETECTION: just started. */
  isNew: boolean
  reason: SortReason
}

export interface ComposedAnalysis extends SubscriptionAnalysis {
  /** Outside every total, with Confirm and Dismiss (PR 5d). */
  suggested: SuggestedStream[]
  /** Dismissed streams; `mark` is the dismissal, which Restore deletes. */
  dismissed: SuggestedStream[]
}

interface Verdict { id: string; kind: MarkKind; createdAt: Date; transactionId: string }

const later = (a: Verdict, b: Verdict) =>
  a.createdAt.getTime() !== b.createdAt.getTime() ? a.createdAt > b.createdAt : a.id > b.id

/** The sorting hides it for a reason a confirmation can't override. */
const composable = (s: SortedStream) => s.sort.bucket !== 'hidden' || s.sort.reason === 'ended-unconfirmed'

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** Plaid's predicted date when it's today or later; otherwise our own prediction. */
function nextCharge(s: EnrichedStream, predicted: Date | null, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  if (predicted && predicted.getTime() >= today) {
    return { nextChargeDate: isoDay(predicted), daysUntilNextCharge: Math.round((predicted.getTime() - today) / DAY_MS) }
  }
  return predictNextCharge(s, now)
}

/** One stream as the tab shows it. Amounts from its posted charges in our rows. */
function fromStream(
  { stream, charges }: SortedStream,
  bucket: 'subscription' | 'bill',
  verdict: Verdict | null,
  now: Date,
): EnrichedStream {
  const last = charges[charges.length - 1]
  const posted = charges.filter((c) => !c.pending).map((c) => c.amount)
  const frequency = readFrequency(stream.frequency) as Frequency
  const status = stream.isActive ? 'active' : 'ended'
  const s: EnrichedStream = {
    merchant: stream.merchantName ?? last.merchantLabel,
    cleanMerchant: stream.merchantName ?? last.merchantLabel,
    // The merchant's identity, as the old detector keyed it, so an alert
    // fingerprint (price_up:<key>:<date>) doesn't change at the switch.
    key: last.merchantKey,
    kind: bucket,
    category: mapPlaidCategory(last.categoryPrimary ?? stream.pfcPrimary),
    frequency,
    lastAmount: Number(last.amount.toFixed(2)),
    lastDate: isoDay(last.date),
    lastChargePending: last.pending,
    monthlyAmount: monthlyAmount(bucket, posted, frequency) ?? 0,
    source: 'plaid',
    priceChange: status === 'ended' ? null : seriesPriceChange(posted),
    isDuplicate: false,
    nextChargeDate: null,
    daysUntilNextCharge: null,
    txIds: charges.map((c) => c.id),
    mark: verdict ? { id: verdict.id } : null,
    status,
  }
  if (isCounted(s)) Object.assign(s, nextCharge(s, stream.predictedNextDate, now))
  return s
}

function suggestion(p: SortedStream, verdict: Verdict | null, now: Date): SuggestedStream {
  const confirmsAs = p.sort.confirmsAs ?? 'subscription'
  const s = fromStream(p, confirmsAs, verdict, now)
  // Not counted, so no next charge: Upcoming is for what's counted.
  return { ...s, nextChargeDate: null, daysUntilNextCharge: null, confirmsAs, isNew: p.stream.status === 'EARLY_DETECTION', reason: p.sort.reason }
}

export async function composeSubscriptions(userId: string, now: Date = new Date()): Promise<ComposedAnalysis> {
  const [sorted, verdicts] = await Promise.all([
    sortUserStreams(userId),
    prisma.subscriptionMark.findMany({
      where: { userId },
      select: { id: true, kind: true, createdAt: true, transactionId: true },
    }),
  ])

  const verdictsOn = new Map<string, Verdict[]>()
  for (const v of verdicts) verdictsOn.set(v.transactionId, [...(verdictsOn.get(v.transactionId) ?? []), v])
  const latestOn = (s: SortedStream): Verdict | null => {
    let best: Verdict | null = null
    for (const c of s.charges) for (const v of verdictsOn.get(c.id) ?? []) if (!best || later(v, best)) best = v
    return best
  }

  // Place every stream a verdict or the sorting can show.
  type Placed = { p: SortedStream; verdict: Verdict | null }
  const confirmed: Array<Placed & { bucket: 'subscription' | 'bill' }> = []
  const shown: Array<Placed & { bucket: 'subscription' | 'bill' }> = []
  const suggested: Placed[] = []
  const dismissed: Placed[] = []
  const inComposable = new Set<string>()
  for (const p of sorted) {
    if (!composable(p)) continue
    p.charges.forEach((c) => inComposable.add(c.id))
    const verdict = latestOn(p)
    if (verdict?.kind === 'dismissed') dismissed.push({ p, verdict })
    else if (verdict?.kind === 'confirmed') {
      const bucket = p.sort.bucket === 'subscription' || p.sort.bucket === 'bill' ? p.sort.bucket : (p.sort.confirmsAs ?? 'subscription')
      confirmed.push({ p, verdict, bucket })
    } else if (p.sort.bucket === 'subscription' || p.sort.bucket === 'bill') shown.push({ p, verdict: null, bucket: p.sort.bucket })
    else if (p.sort.bucket === 'suggested') suggested.push({ p, verdict: null })
    // else: ended-unconfirmed with no confirmation stays hidden.
  }

  const claimed = new Set<string>()
  /** Claim an item's charges, unless one is already shown by something else. */
  const claim = (ids: string[]) => {
    if (ids.some((id) => claimed.has(id))) return false
    ids.forEach((id) => claimed.add(id))
    return true
  }
  const out: EnrichedStream[] = []

  // 1. Confirmed streams, latest verdict first.
  confirmed.sort((a, b) => (later(a.verdict!, b.verdict!) ? -1 : 1))
  for (const c of confirmed) {
    if (claim(c.p.charges.map((x) => x.id))) out.push(fromStream(c.p, c.bucket, c.verdict, now))
  }

  // 2. Marks whose anchor is in no stream that can show: their series, as today.
  const marks = (await loadMarks(userId)).filter((m) => !inComposable.has(m.transaction.id))
  if (marks.length > 0) {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MARK_LOOKBACK_MONTHS, now.getUTCDate()))
    const rows = await loadSpendRows(userId, now, since)
    const rowOf = new Map(rows.map((r) => [r.id, r]))
    for (const s of markedStreams(marks, rows, now, since, claimed)) {
      // The one monthly-amount definition: a subscription's last posted charge.
      const posted = s.txIds.map((id) => rowOf.get(id)).filter((r) => r && !r.pending).map((r) => r!.amount)
      s.monthlyAmount = monthlyAmount('subscription', posted, s.frequency) ?? 0
      if (isCounted(s)) Object.assign(s, predictNextCharge(s, now))
      out.push(s)
    }
  }

  // 3 and 4. Everything else, folded where a charge is already shown.
  for (const s of shown) {
    if (claim(s.p.charges.map((x) => x.id))) out.push(fromStream(s.p, s.bucket, null, now))
  }
  const suggestions: SuggestedStream[] = []
  for (const s of suggested) {
    if (claim(s.p.charges.map((x) => x.id))) suggestions.push(suggestion(s.p, null, now))
  }

  return {
    ...finishAnalysis(out),
    suggested: suggestions,
    dismissed: dismissed.map((d) => suggestion(d.p, d.verdict, now)),
  }
}
