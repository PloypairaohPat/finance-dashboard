// ─────────────────────────────────────────────────────────────────
//  streamSorting — the one definition (M7.6 PR 3): every recurring stream
//  is sorted here, once, before any surface sees it.
//
//  Pure: no database access. Its input carries our classifier's verdict on
//  each of the stream's transactions that resolved to a row of the stream's
//  own user (services/streamSorting.service.ts does that resolution).
//
//  Each branch is explicit; the order is the order below.
//
//    1. Inflow                               → hidden   (inflows are PR 6's)
//    2. Status Plaid hasn't documented        → hidden   (see STATUS below)
//       TOMBSTONED                            → hidden
//    3. Our verdict on its transactions:
//         none resolved                       → hidden   (no verdict, nothing to anchor on)
//         mixed                               → hidden   (its non-spend charges would count as spending)
//         all transfer                        → hidden
//         all something else, not spend       → hidden
//         all spend                           → on
//    4. EARLY_DETECTION                       → suggested, whatever its category
//       UNKNOWN status                        → suggested
//    5. Category, detailed code before primary:
//         bill codes                          → bill
//         TRANSFER_OUT                        → suggested (a confirmed one is a bill)
//         the detector's old false positives  → suggested
//         subscription codes                  → subscription
//         on neither list, or no category     → suggested
//    6. Suggested but inactive                → hidden   (nothing to confirm: it stopped)
//
//  counts: a stream counts toward totals only when it's a subscription or a
//  bill, active, and its frequency is known. Inactive ones show as ended
//  (subscriptions and bills by category; a confirmed one through its mark);
//  UNKNOWN-frequency ones follow the unknown-schedule rule. Suggested and
//  hidden streams never count.
// ─────────────────────────────────────────────────────────────────

import type { StreamDirection } from '@prisma/client'
import type { ClassKind } from './classifier'
import { STREAM_STATUSES, readFrequency } from './recurringStreams'

export type StreamBucket = 'subscription' | 'bill' | 'suggested' | 'hidden'

export const SORT_REASONS = [
  'inflow',
  'status-unrecognised',
  'tombstoned',
  'unmatched',
  'mixed',
  'transfer',
  'not-spend',
  'early-detection',
  'status-unknown',
  'bill-category',
  'transfer-out',
  'often-not-recurring',
  'subscription-category',
  'category-unlisted',
  'no-category',
  'ended-unconfirmed',
] as const
export type SortReason = (typeof SORT_REASONS)[number]

export interface SortInput {
  direction: StreamDirection
  /** As stored: Plaid's value, unread. */
  status: string
  frequency: string
  isActive: boolean
  pfcPrimary: string | null
  pfcDetailed: string | null
  /** Our verdict on each of its transactions found in the user's rows. */
  verdicts: readonly ClassKind[]
}

export interface StreamSort {
  bucket: StreamBucket
  reason: SortReason
  /** Toward totals: a subscription or bill, active, with a known frequency. */
  counts: boolean
  /** For a suggested stream, or one hidden as ended-unconfirmed: where it lands once confirmed. */
  confirmsAs?: 'subscription' | 'bill'
}

// ── categories: Plaid's PFCv2 codes ───────────────────────────────
//
// Every code is from Plaid's taxonomy file (plaid.com/documents/
// pfc-taxonomy-all.csv), where each one is the same in v1 and v2; our Items
// return v2 (docs/m7.3-taxonomy-audit.md). Detailed codes match exactly, and
// before primaries, so TRANSPORTATION_GAS can't match RENT_AND_UTILITIES_GAS_AND_ELECTRICITY.

/** Obligations: what you owe, not a service you chose. */
export const BILL_PRIMARIES = ['RENT_AND_UTILITIES', 'LOAN_PAYMENTS', 'BANK_FEES'] as const
export const BILL_DETAILED = ['GENERAL_SERVICES_INSURANCE', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'] as const

/** The custom detector's old false positives: regular shopping that recurs, not a subscription. */
export const OFTEN_NOT_RECURRING_PRIMARIES = ['FOOD_AND_DRINK', 'GENERAL_MERCHANDISE'] as const
/** Gas sits inside TRANSPORTATION, so only its detailed code can single it out. */
export const OFTEN_NOT_RECURRING_DETAILED = ['TRANSPORTATION_GAS'] as const

/** Services people sign up for. Anything else spend-like defaults to suggested. */
export const SUBSCRIPTION_DETAILED = [
  'ENTERTAINMENT_TV_AND_MOVIES',
  'ENTERTAINMENT_MUSIC_AND_AUDIO',
  'ENTERTAINMENT_VIDEO_GAMES',
  'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS',
  'GENERAL_SERVICES_STORAGE',
] as const

const has = (list: readonly string[], value: string | null) => value !== null && list.includes(value)

type ByCategory = { bucket: 'subscription' | 'bill' | 'suggested'; reason: SortReason; confirmsAs: 'subscription' | 'bill' }

function byCategory(primary: string | null, detailed: string | null): ByCategory {
  if (has(BILL_DETAILED, detailed)) return { bucket: 'bill', reason: 'bill-category', confirmsAs: 'bill' }
  if (has(OFTEN_NOT_RECURRING_DETAILED, detailed)) return { bucket: 'suggested', reason: 'often-not-recurring', confirmsAs: 'subscription' }
  if (has(SUBSCRIPTION_DETAILED, detailed)) return { bucket: 'subscription', reason: 'subscription-category', confirmsAs: 'subscription' }
  if (has(BILL_PRIMARIES, primary)) return { bucket: 'bill', reason: 'bill-category', confirmsAs: 'bill' }
  // A recurring payment the classifier counts as spending (to a person, or an
  // account Ledger can't see): maybe an obligation, maybe not. Confirmed, it's a bill.
  if (primary === 'TRANSFER_OUT') return { bucket: 'suggested', reason: 'transfer-out', confirmsAs: 'bill' }
  if (has(OFTEN_NOT_RECURRING_PRIMARIES, primary)) return { bucket: 'suggested', reason: 'often-not-recurring', confirmsAs: 'subscription' }
  // A false subscription costs more trust than one extra confirm.
  if (primary === null && detailed === null) return { bucket: 'suggested', reason: 'no-category', confirmsAs: 'subscription' }
  return { bucket: 'suggested', reason: 'category-unlisted', confirmsAs: 'subscription' }
}

// ── verdicts ──────────────────────────────────────────────────────

const TRANSFER_KINDS: readonly ClassKind[] = ['card_payment', 'internal_transfer', 'savings_transfer']
type VerdictClass = 'spend' | 'transfer' | 'other'
const classOf = (kind: ClassKind): VerdictClass =>
  kind === 'spend' ? 'spend' : TRANSFER_KINDS.includes(kind) ? 'transfer' : 'other'

const hidden = (reason: SortReason): StreamSort => ({ bucket: 'hidden', reason, counts: false })

export function sortStream(s: SortInput): StreamSort {
  // 1. Inflows: pay, interest and refunds are PR 6's concern, never a subscription or bill.
  if (s.direction === 'inflow') return hidden('inflow')

  // 2. Status. Plaid documents four values (SDK and spec 2020-09-14_1.762.0):
  // MATURE, EARLY_DETECTION, TOMBSTONED, UNKNOWN. None means merged or split:
  // those are operations an app calls on a user's request, and Ledger calls
  // neither. A value outside the four — which is where a status meaning
  // merged or split would arrive — is never shown. (readStatus would fold it
  // into UNKNOWN, so the raw value is checked here.)
  if (!(STREAM_STATUSES as readonly string[]).includes(s.status)) return hidden('status-unrecognised')
  // An early stream that didn't recur at its next expected date: a false start.
  if (s.status === 'TOMBSTONED') return hidden('tombstoned')

  // 3. Our classifier's verdict on its transactions decides before Plaid's category.
  if (s.verdicts.length === 0) return hidden('unmatched')
  const classes = new Set(s.verdicts.map(classOf))
  if (classes.size > 1) return hidden('mixed')
  const [only] = classes
  if (only === 'transfer') return hidden('transfer')
  if (only === 'other') return hidden('not-spend')

  // 4 and 5. All spend.
  const category = byCategory(s.pfcPrimary, s.pfcDetailed)
  const suggest = (reason: SortReason): StreamSort =>
    // 6. Asking someone to confirm something that already stopped is noise.
    // EARLY_DETECTION is active by nature, so this doesn't reach it in practice.
    // It keeps confirmsAs: a confirmation on it (a mark) still shows it, as ended, there.
    s.isActive
      ? { bucket: 'suggested', reason, counts: false, confirmsAs: category.confirmsAs }
      : { ...hidden('ended-unconfirmed'), confirmsAs: category.confirmsAs }
  // "You just started a subscription": always worth a confirm, never assumed.
  if (s.status === 'EARLY_DETECTION') return suggest('early-detection')
  // Plaid's "none of the others applies": not established, so not assumed either.
  if (s.status === 'UNKNOWN') return suggest('status-unknown')

  if (category.bucket === 'suggested') return suggest(category.reason)
  return {
    bucket: category.bucket,
    reason: category.reason,
    counts: s.isActive && readFrequency(s.frequency) !== 'UNKNOWN',
  }
}
