// ─────────────────────────────────────────────────────────────────
//  missedPaycheck.service — the stored inputs the missed-paycheck alert reads
//  (lib/missedPaycheck.ts judges them). Stored data only: never a Plaid call.
//  Everything is the user's own: their setting, their inflow streams, the
//  stream deposits resolved against their rows, their accounts and Items.
// ─────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client'
import defaultPrisma from '../lib/prisma'
import { exclusionOf, type PayFrequency } from '../lib/paydays'
import type { PaycheckInput } from '../lib/missedPaycheck'

/** The user's inflow streams that qualify: salary code, MATURE, active, fixed frequency. */
async function qualifyingStreams(userId: string, db: PrismaClient) {
  const streams = await db.recurringStream.findMany({
    where: { userId, direction: 'inflow' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return streams.filter((s) => exclusionOf(s) === null)
}

/** Whether the user has a regular paycheck the alert could watch: for the Settings dialog. */
export async function regularPaycheckFound(userId: string, db: PrismaClient = defaultPrisma): Promise<boolean> {
  return (await qualifyingStreams(userId, db)).length > 0
}

export async function loadPaycheckInput(userId: string, db: PrismaClient = defaultPrisma): Promise<PaycheckInput> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { missedPaycheckAlerts: true } })
  if (!user?.missedPaycheckAlerts) return { enabled: false, streams: [], items: new Map() }

  const streams = await qualifyingStreams(userId, db)
  if (streams.length === 0) return { enabled: true, streams: [], items: new Map() }

  const [rows, accounts, items] = await Promise.all([
    // A stream's deposits, resolved against this user's live rows only.
    db.transaction.findMany({
      where: { userId, deletedAt: null, plaidTransactionId: { in: [...new Set(streams.flatMap((s) => s.plaidTransactionIds))] } },
      select: { id: true, plaidTransactionId: true, date: true, amount: true },
    }),
    db.account.findMany({ where: { userId }, select: { id: true, plaidAccountId: true, name: true } }),
    db.plaidItem.findMany({ where: { userId }, select: { id: true, lastSyncedAt: true, streamsRefreshedAt: true, status: true } }),
  ])
  const rowOf = new Map(rows.map((r) => [r.plaidTransactionId, r]))
  const accountOf = new Map(accounts.map((a) => [a.plaidAccountId, a]))

  return {
    enabled: true,
    items: new Map(items.map((it) => [it.id, { lastSyncedAt: it.lastSyncedAt, streamsRefreshedAt: it.streamsRefreshedAt, status: it.status }])),
    streams: streams.map((s) => {
      const account = accountOf.get(s.plaidAccountId)
      return {
        plaidItemId: s.plaidItemId,
        plaidAccountId: s.plaidAccountId,
        accountId: account?.id ?? null,
        accountName: account?.name ?? 'your account',
        payer: s.merchantName ?? s.description,
        frequency: s.frequency as PayFrequency,
        predictedNextDate: s.predictedNextDate,
        deposits: s.plaidTransactionIds
          .map((t) => rowOf.get(t))
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
          .map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount) })),
      }
    }),
  }
}
