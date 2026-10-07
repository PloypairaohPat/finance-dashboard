// ─────────────────────────────────────────────────────────────────
//  streamSorting.service — a user's stored streams, sorted by the one
//  definition (lib/streamSorting.ts). Reads only; never calls Plaid.
//
//  A stream's transaction ids are Plaid's. They resolve to rows of the
//  stream's own user only, and never to a soft-deleted row: an id that
//  names another user's transaction resolves to nothing (M7.6 audit, the
//  isolation case for PR 5).
// ─────────────────────────────────────────────────────────────────

import type { RecurringStream } from '@prisma/client'
import prisma from '../lib/prisma'
import type { ClassKind } from '../lib/classifier'
import { sortStream, type StreamSort } from '../lib/streamSorting'
import { classifyWindow, type ClassifiedRow } from './classification.service'
import { getPeriodStartDay } from './user.service'

const DAY_MS = 86_400_000

/** Plaid transaction id → our row, for this user's live rows only. */
export async function resolveStreamRows(userId: string, plaidTransactionIds: readonly string[]) {
  if (plaidTransactionIds.length === 0) return new Map<string, { id: string; date: Date }>()
  const rows = await prisma.transaction.findMany({
    where: { userId, deletedAt: null, plaidTransactionId: { in: [...new Set(plaidTransactionIds)] } },
    select: { id: true, plaidTransactionId: true, date: true },
  })
  return new Map(rows.map((r) => [r.plaidTransactionId, { id: r.id, date: r.date }]))
}

export interface SortedStream {
  stream: RecurringStream
  sort: StreamSort
  /** Its transactions found in the user's live rows, oldest first, with our verdicts. */
  charges: ClassifiedRow[]
  /**
   * Its transactions the user's rows hold as removed (soft-deleted by a sync).
   * They never count toward anything; a verdict on one still applies to the
   * stream, so a confirmation or dismissal doesn't vanish when Plaid removes
   * the charge it sits on. The stream's own user's rows only.
   */
  removedChargeIds: string[]
}

/** Every stored stream of the user, each with its bucket, reason and whether it counts. */
export async function sortUserStreams(userId: string): Promise<SortedStream[]> {
  const streams = await prisma.recurringStream.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const rowOf = await resolveStreamRows(userId, streams.flatMap((s) => s.plaidTransactionIds))
  const removedOf = new Map(
    (await prisma.transaction.findMany({
      where: { userId, deletedAt: { not: null }, plaidTransactionId: { in: [...new Set(streams.flatMap((s) => s.plaidTransactionIds))] } },
      select: { id: true, plaidTransactionId: true },
    })).map((r) => [r.plaidTransactionId, r.id]),
  )

  // One classification across every resolved row's dates.
  const classified = new Map<string, ClassifiedRow>()
  if (rowOf.size > 0) {
    const times = [...rowOf.values()].map((r) => r.date.getTime())
    const { rows } = await classifyWindow(userId, {
      since: new Date(Math.min(...times)),
      until: new Date(Math.max(...times) + DAY_MS),
      startDay: await getPeriodStartDay(userId),
    })
    for (const r of rows) classified.set(r.id, r)
  }

  return streams.map((stream) => {
    const charges = [...new Set(stream.plaidTransactionIds)]
      .map((t) => rowOf.get(t))
      .map((row) => (row ? classified.get(row.id) : undefined))
      .filter((r): r is ClassifiedRow => r !== undefined)
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id))
    const verdicts: ClassKind[] = charges.map((c) => c.verdict.kind)
    return {
      stream,
      charges,
      removedChargeIds: [...new Set(stream.plaidTransactionIds)].map((t) => removedOf.get(t)).filter((id): id is string => id !== undefined),
      sort: sortStream({
        direction: stream.direction,
        status: stream.status,
        frequency: stream.frequency,
        isActive: stream.isActive,
        pfcPrimary: stream.pfcPrimary,
        pfcDetailed: stream.pfcDetailed,
        verdicts,
      }),
    }
  })
}
