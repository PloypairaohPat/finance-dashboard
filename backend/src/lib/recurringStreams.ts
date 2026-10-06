// ─────────────────────────────────────────────────────────────────
//  recurringStreams — Plaid's recurring streams, as RecurringStream rows,
//  and reading back the open-ended values Plaid stores in them.
//
//  Pure: no database access. M7.6 PR 2's writer calls streamColumns; the
//  sorting (PR 3) and the tab (PR 5) call readFrequency / readStatus.
// ─────────────────────────────────────────────────────────────────

import type { StreamDirection } from '@prisma/client'

/**
 * A stream as Plaid sends it, as far as we read it. Local rather than the
 * SDK's TransactionStream because plaid 24.0.0's type has no
 * predicted_next_date, which Plaid does send (docs/m7.6-audit.md); it's
 * nullable here because Plaid's spec allows it to be absent. Upgrading the
 * SDK is a separate chore, after which this can lean on its type.
 */
export interface PlaidStream {
  stream_id: string
  account_id: string
  description: string
  merchant_name?: string | null
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null
  frequency: string
  status: string
  is_active: boolean
  first_date: string
  last_date: string
  predicted_next_date?: string | null
  average_amount?: { amount?: number | null; iso_currency_code?: string | null } | null
  last_amount?: { amount?: number | null; iso_currency_code?: string | null } | null
  transaction_ids?: string[] | null
}

/**
 * An amount in Transaction.amount's convention: positive is money out of the
 * account, negative is money in. Taken from the stream's direction, never from
 * the sign Plaid sent: Plaid documents the sign for transactions but not for
 * stream amounts, and a flipped sign would flip PR 5's totals and price-up.
 */
export function signedAmount(amount: number | null | undefined, direction: StreamDirection): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null
  const magnitude = Math.abs(amount)
  return direction === 'outflow' ? magnitude : -magnitude
}

const asDate = (iso: string | null | undefined): Date | null =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00.000Z`) : null

/** The columns for one stream. Raw values and Plaid's ids; nothing derived. */
export function streamColumns(
  stream: PlaidStream,
  ctx: { userId: string; plaidItemId: string; direction: StreamDirection; plaidUpdatedAt: Date },
) {
  return {
    userId: ctx.userId,
    plaidItemId: ctx.plaidItemId,
    streamId: stream.stream_id,
    plaidAccountId: stream.account_id,
    direction: ctx.direction,
    description: stream.description,
    merchantName: stream.merchant_name ?? null,
    pfcPrimary: stream.personal_finance_category?.primary ?? null,
    pfcDetailed: stream.personal_finance_category?.detailed ?? null,
    // Stored as Plaid sent them; read through readFrequency / readStatus.
    frequency: stream.frequency,
    status: stream.status,
    isActive: stream.is_active,
    firstDate: asDate(stream.first_date)!,
    lastDate: asDate(stream.last_date)!,
    predictedNextDate: asDate(stream.predicted_next_date),
    averageAmount: signedAmount(stream.average_amount?.amount, ctx.direction),
    lastAmount: signedAmount(stream.last_amount?.amount, ctx.direction),
    isoCurrencyCode: stream.last_amount?.iso_currency_code ?? stream.average_amount?.iso_currency_code ?? null,
    plaidTransactionIds: stream.transaction_ids ?? [],
    plaidUpdatedAt: ctx.plaidUpdatedAt,
  }
}

// ── reading Plaid's open enums back ───────────────────────────────
//
// status and frequency are text columns because Plaid adds values. Code that
// reads them treats them as a closed set, so anything unknown becomes the safe
// default — UNKNOWN, which the sorting keeps out of totals — and is logged
// once per value. (The alert-severity lesson: a String column the code treats
// as a closed set, with nothing catching a new value.)

export const STREAM_FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY', 'ANNUALLY', 'UNKNOWN'] as const
export const STREAM_STATUSES = ['MATURE', 'EARLY_DETECTION', 'TOMBSTONED', 'UNKNOWN'] as const
export type StreamFrequency = (typeof STREAM_FREQUENCIES)[number]
export type StreamStatus = (typeof STREAM_STATUSES)[number]

const warned = new Set<string>()
function closed<T extends string>(kind: string, known: readonly T[], fallback: T, value: string): T {
  if ((known as readonly string[]).includes(value)) return value as T
  const key = `${kind}:${value}`
  if (!warned.has(key)) {
    warned.add(key)
    // An enum value from Plaid, never personal data.
    console.warn(`[recurring] unknown stream ${kind} "${value}"; treating it as ${fallback}`)
  }
  return fallback
}

export const readFrequency = (value: string): StreamFrequency =>
  closed('frequency', STREAM_FREQUENCIES, 'UNKNOWN', value)

export const readStatus = (value: string): StreamStatus =>
  closed('status', STREAM_STATUSES, 'UNKNOWN', value)
