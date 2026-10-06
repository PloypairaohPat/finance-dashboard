// ─────────────────────────────────────────────────────────────────
//  monthlyAmount — the one definition of what a recurring item costs per
//  month, for the Subscriptions card and the Bills card alike (M7.6 PR 5).
//
//  The amount depends on what the number means:
//    subscription — its last posted charge IS its price.
//    bill         — its last charge is one period's usage, so the mean of its
//                   last BILL_MEAN_OF posted charges (fewer if that's all).
//  Both come from our own rows, posted only, so they reconcile with the
//  transaction list. Then per frequency. An UNKNOWN frequency, or nothing
//  posted yet, has no monthly amount: it stays out of the totals.
// ─────────────────────────────────────────────────────────────────

import type { StreamFrequency } from './recurringStreams'

/** Charges per month at each known frequency. */
export const MONTHLY_MULTIPLIER: Record<Exclude<StreamFrequency, 'UNKNOWN'>, number> = {
  WEEKLY: 4.33, BIWEEKLY: 2.17, SEMI_MONTHLY: 2, MONTHLY: 1, ANNUALLY: 1 / 12,
}

/** How many of a bill's recent posted charges its monthly amount averages. */
export const BILL_MEAN_OF = 3

const round2 = (n: number) => Number(n.toFixed(2))

/** One charge, per month. null for an UNKNOWN frequency. */
export function perMonth(amount: number, frequency: StreamFrequency): number | null {
  if (frequency === 'UNKNOWN') return null
  return round2(amount * MONTHLY_MULTIPLIER[frequency])
}

/**
 * What a subscription or bill costs per month.
 * `postedAmounts` are its posted charges, oldest first; pending ones are left out by the caller.
 */
export function monthlyAmount(
  bucket: 'subscription' | 'bill',
  postedAmounts: readonly number[],
  frequency: StreamFrequency,
): number | null {
  if (postedAmounts.length === 0) return null
  const charge = bucket === 'subscription'
    ? postedAmounts[postedAmounts.length - 1]
    : mean(postedAmounts.slice(-BILL_MEAN_OF))
  return perMonth(charge, frequency)
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
