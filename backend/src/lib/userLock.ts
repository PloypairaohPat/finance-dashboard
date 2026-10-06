// ─────────────────────────────────────────────────────────────────
//  lockUserRows — one per-user Postgres advisory lock, held until the
//  transaction that took it ends.
//
//  Every transaction that adds or removes a user's Plaid-derived rows takes
//  it: the link path's after-exchange check, unlink and the duplicate-link
//  discard (removePlaidItemRows), account deletion, and the recurring-streams
//  refresh. With restrict foreign keys, a stream inserted while an Item is
//  being removed would make the removal fail — possibly after Plaid has
//  already removed the Item. Taking the same lock serialises them: the
//  second waits, then sees the first's result.
//
//  A Postgres lock, not an in-memory one: Railway briefly runs two instances
//  during a deploy. Re-entrant within one transaction, so a transaction that
//  touches several of the same user's Items can take it more than once.
// ─────────────────────────────────────────────────────────────────

import type { Prisma } from '@prisma/client'

export async function lockUserRows(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ledger-user-rows'), hashtext(${userId}))`
}
