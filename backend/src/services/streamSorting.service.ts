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
import { classifyWindow } from './classification.service'
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
}

/** Every stored stream of the user, each with its bucket, reason and whether it counts. */
export async function sortUserStreams(userId: string): Promise<SortedStream[]> {
  const streams = await prisma.recurringStream.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const rowOf = await resolveStreamRows(userId, streams.flatMap((s) => s.plaidTransactionIds))

  // One classification across every resolved row's dates.
  const verdictOf = new Map<string, ClassKind>()
  if (rowOf.size > 0) {
    const times = [...rowOf.values()].map((r) => r.date.getTime())
    const { rows } = await classifyWindow(userId, {
      since: new Date(Math.min(...times)),
      until: new Date(Math.max(...times) + DAY_MS),
      startDay: await getPeriodStartDay(userId),
    })
    for (const r of rows) verdictOf.set(r.id, r.verdict.kind)
  }

  return streams.map((stream) => {
    const verdicts = stream.plaidTransactionIds
      .map((t) => rowOf.get(t))
      .map((row) => (row ? verdictOf.get(row.id) : undefined))
      .filter((k): k is ClassKind => k !== undefined)
    return {
      stream,
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
