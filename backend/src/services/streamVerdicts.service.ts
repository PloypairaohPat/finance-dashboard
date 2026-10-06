// ─────────────────────────────────────────────────────────────────
//  streamVerdicts.service — Confirm and Dismiss (M7.6 PR 5c).
//
//  A verdict is a SubscriptionMark with a kind, anchored on one charge.
//  Writing one replaces every other verdict on the charges of the stream(s)
//  that charge belongs to, in one transaction under the per-user lock, so a
//  stream carries one answer: the one just given. Confirming a dismissed
//  charge replaces the dismissal. A charge in no stream can be confirmed (a
//  mark, as today) but not dismissed: there's nothing to dismiss.
//
//  A verdict anchors only on a posted, live charge of the caller's: posting
//  replaces a pending row, and a soft-deleted one is gone, so a verdict on
//  either would be lost. Another user's charge or verdict answers 404, the
//  same as one that doesn't exist.
//
//  Nothing calls this until PR 5d/5e. It writes; composeSubscriptions reads.
// ─────────────────────────────────────────────────────────────────

import type { MarkKind, Prisma } from '@prisma/client'
import prisma from '../lib/prisma'
import { lockUserRows } from '../lib/userLock'
import { MarkError, isSpend } from './subscriptionMarks.service'

export const VERDICTS: readonly MarkKind[] = ['confirmed', 'dismissed']

const PENDING_REASON =
  "This charge is still pending. A pending row is replaced by a new one when it posts, so an answer on it would be lost; answer once it has posted."
const DELETED_REASON = 'This charge has been removed, so an answer on it would be lost.'

export interface VerdictRow { id: string; kind: MarkKind; transactionId: string; createdAt: Date }

export interface VerdictHooks {
  /** Test seam: runs after the old verdicts are cleared, before the new one is written. */
  afterClear?: () => Promise<unknown>
}

export async function writeVerdict(
  userId: string,
  transactionId: unknown,
  verdict: unknown,
  hooks: VerdictHooks = {},
): Promise<VerdictRow> {
  if (typeof transactionId !== 'string' || transactionId === '') throw new MarkError(400, 'transactionId is required.')
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw new MarkError(400, `verdict must be one of: ${VERDICTS.join(', ')}.`)
  }
  const kind = verdict as MarkKind

  // Ownership first, deleted rows included, so another user's id is a 404 and
  // the caller's own removed row is a 409 that says why.
  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, userId },
    select: { id: true, date: true, pending: true, deletedAt: true, plaidTransactionId: true },
  })
  if (!tx) throw new MarkError(404, 'Transaction not found')
  if (tx.deletedAt) throw new MarkError(409, DELETED_REASON)
  if (tx.pending) throw new MarkError(409, PENDING_REASON)

  if (kind === 'confirmed' && !(await isSpend(userId, tx)).spend) {
    throw new MarkError(409, 'Only spending can be a subscription or a bill.')
  }

  return prisma.$transaction(async (db: Prisma.TransactionClient) => {
    await lockUserRows(db, userId)
    // The caller's streams holding this charge, and every charge of theirs in them.
    const streams = await db.recurringStream.findMany({
      where: { userId, plaidTransactionIds: { has: tx.plaidTransactionId } },
      select: { plaidTransactionIds: true },
    })
    if (kind === 'dismissed' && streams.length === 0) {
      throw new MarkError(409, 'Only a recurring stream can be dismissed, and this charge is in none.')
    }
    const plaidIds = [...new Set(streams.flatMap((s) => s.plaidTransactionIds))]
    const rows = plaidIds.length === 0 ? [] : await db.transaction.findMany({
      where: { userId, plaidTransactionId: { in: plaidIds } },
      select: { id: true },
    })
    const charges = [...new Set([tx.id, ...rows.map((r) => r.id)])]

    // One answer per stream: clear the caller's verdicts on its charges, then write this one.
    await db.subscriptionMark.deleteMany({ where: { userId, transactionId: { in: charges } } })
    if (hooks.afterClear) await hooks.afterClear()
    return db.subscriptionMark.create({
      data: { userId, transactionId: tx.id, kind },
      select: { id: true, kind: true, transactionId: true, createdAt: true },
    })
  })
}

/** Undo a confirmation, or Restore a dismissal. 404 for another user's verdict. */
export async function deleteVerdict(userId: string, verdictId: string): Promise<void> {
  const { count } = await prisma.subscriptionMark.deleteMany({ where: { id: verdictId, userId } })
  if (count === 0) throw new MarkError(404, 'Verdict not found')
}
