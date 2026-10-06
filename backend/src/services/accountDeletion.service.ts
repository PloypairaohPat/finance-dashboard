// ─────────────────────────────────────────────────────────────────
//  accountDeletion.service — "Delete account and all data".
//
//  One code path for both triggers: DELETE /user (the Settings action) and
//  scripts/delete-user.ts (for someone who asks by message).
//
//  Order, so nothing is orphaned and nothing is recreated:
//    1. Ban in Clerk. Every session is revoked and sign-in blocked, so the
//       user's own requests can't write while this runs. (A token issued just
//       before can still verify for about a minute; step 5 covers it.)
//    2. /item/remove at Plaid for every Item: Plaid stops billing and loses
//       our access. "Already gone" counts as removed. The item_id, never the
//       token, goes to Sentry on a failure.
//    3. Every row, in one transaction: every other user's fingerprint is
//       taken before and after and must be identical, and the user must have
//       nothing left in any table, or the whole transaction rolls back. A
//       serialization failure or deadlock reruns only this transaction, a
//       few times, each attempt with a fresh lock and fresh fingerprints.
//
//    Whether a failure unbans depends on whether anything irreversible has
//    happened, not on the error. Before any Item is removed at Plaid: unban,
//    "try again". Once any Item is removed: the user stays banned, Sentry gets
//    DELETION_INCOMPLETE, and the user is told the deletion is underway.
//    delete-user.ts finishes it (after a fix, if a check failed).
//    4. Delete the Clerk account. If that fails, the data is already gone and
//       the user stays banned: Sentry gets the Clerk user id, and running the
//       deletion again finishes it (steps 2 and 3 find nothing to do).
//    5. Sweep again: anything written between 3 and now is deleted, and the
//       user is checked empty.
// ─────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/node'
import type { PlaidApi } from 'plaid'
import { Prisma, type PrismaClient } from '@prisma/client'
import defaultPrisma from '../lib/prisma'
import { DEMO_USER_ID } from '../middleware/auth'
import { removeItemAtPlaid } from './plaidItems.service'
import { lockUserRows } from '../lib/userLock'
import { NON_DEMO_TABLES, diffBaselines, takeBaseline } from '../lib/userFingerprint'

/** What the user types to confirm. Compared ignoring case and surrounding spaces. */
export const DELETE_CONFIRMATION = 'delete my data'

export const confirms = (typed: unknown) =>
  typeof typed === 'string' && typed.trim().toLowerCase() === DELETE_CONFIRMATION

/** [table, owner column, Prisma delegate] in foreign-key-safe order. User last. */
export const DELETION_ORDER = [
  ['SubscriptionMark', 'userId', 'subscriptionMark'],
  ['Transaction', 'userId', 'transaction'],
  ['Account', 'userId', 'account'],
  ['RecurringStream', 'userId', 'recurringStream'],
  ['PlaidItem', 'userId', 'plaidItem'],
  ['Budget', 'userId', 'budget'],
  ['BalanceSnapshot', 'userId', 'balanceSnapshot'],
  ['Alert', 'userId', 'alert'],
  ['Goal', 'userId', 'goal'],
  ['User', 'id', 'user'],
] as const

export class DeletionError extends Error {
  constructor(public readonly status: 400 | 403 | 500, message: string) {
    super(message)
  }
}

/** The Sentry title for a deletion left part-done. An alert rule notifies on it. */
export const DELETION_INCOMPLETE = 'account deletion: incomplete, user still banned, finish with delete-user.ts'

/** What the user is told then. Kept by hand: DELETION_INCOMPLETE is the reminder. */
export const DELETION_UNDERWAY_MESSAGE =
  "Your deletion is underway and will be completed. Your bank connections are already disconnected and you've been signed out."

/** Something irreversible happened and the rest didn't: banned, reported, to finish by hand. */
export class DeletionUnderway extends Error {
  constructor() {
    super('Deletion incomplete: the user is still banned. Rerun delete-user.ts to finish it, after a fix if a check failed (see Sentry).')
  }
}

/** One of the transaction's own checks refused to commit. Never retried. */
class CheckFailed extends Error {
  constructor(public readonly reason: 'other users changed' | 'rows remained', message: string) {
    super(message)
  }
}

/** Backoff before the second and third attempts of the row transaction. */
export const ROW_RETRY_DELAYS_MS = [100, 300]
export const ROW_ATTEMPTS = ROW_RETRY_DELAYS_MS.length + 1

/** Prisma's write-conflict-or-deadlock, or Postgres's serialization failure or deadlock. */
export function isConflict(err: any): boolean {
  if (err?.code === 'P2034') return true
  const pg = err?.meta?.code ?? err?.cause?.code
  return pg === '40001' || pg === '40P01'
}

/** The demo user is never deletable, through any path. */
export function assertDeletable(userId: string): void {
  if (!userId) throw new DeletionError(400, 'No user to delete.')
  if (userId === DEMO_USER_ID) throw new DeletionError(403, 'The demo user is not deletable.')
}

/** The Clerk calls this needs. clerkClient.users in the app; a mock in tests. */
export interface ClerkUsers {
  banUser(userId: string): Promise<unknown>
  unbanUser(userId: string): Promise<unknown>
  deleteUser(userId: string): Promise<unknown>
}

export interface DeletionDeps {
  plaidClient: PlaidApi
  clerk: ClerkUsers
  /** Defaults to the app's client; the script passes its own on the resolved URL. */
  db?: PrismaClient
  /** Test seams: run inside the transaction, and between it and the Clerk deletion. */
  hooks?: {
    /** Each attempt, after the fingerprint and before any row is deleted. */
    beforeDelete?: (attempt: number) => Promise<unknown>
    insideTransaction?: (tx: Prisma.TransactionClient) => Promise<unknown>
    beforeClerkDelete?: () => Promise<unknown>
  }
}

export interface DeletionReport {
  itemsRemoved: number
  rowsDeleted: Record<string, number>
  /** False when Clerk refused: data gone, user banned, rerun to finish. */
  clerkDeleted: boolean
  /** Rows the second sweep found and removed. */
  sweptAfter: number
}

/** Clerk says the user doesn't exist (already deleted, e.g. on a rerun). */
const isClerkNotFound = (err: any) => err?.status === 404 || err?.errors?.[0]?.code === 'resource_not_found'

async function countRows(db: PrismaClient | Prisma.TransactionClient, userId: string): Promise<number> {
  let total = 0
  for (const [table, owner] of NON_DEMO_TABLES) {
    const [r] = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${owner}" = $1`, userId,
    )
    total += r.n
  }
  return total
}

async function deleteAll(db: PrismaClient | Prisma.TransactionClient, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [table, owner, delegate] of DELETION_ORDER) {
    const { count } = await (db[delegate] as any).deleteMany({ where: { [owner]: userId } })
    out[table] = count
  }
  return out
}

/** Step 3, one attempt: its own transaction, lock and fingerprints. */
async function deleteRowsOnce(
  db: PrismaClient, userId: string, attempt: number, hooks: DeletionDeps['hooks'],
): Promise<Record<string, number>> {
  return db.$transaction(async (tx) => {
    // The per-user lock: no link, unlink or streams refresh for this user
    // can write between the fingerprints.
    await lockUserRows(tx, userId)
    const before = await takeBaseline(tx, userId)
    if (hooks?.beforeDelete) await hooks.beforeDelete(attempt)
    const deleted = await deleteAll(tx, userId)
    if (hooks?.insideTransaction) await hooks.insideTransaction(tx)
    const damage = diffBaselines(before, await takeBaseline(tx, userId))
    if (damage.length > 0) throw new CheckFailed('other users changed', `other users' rows changed, so nothing was deleted:\n  ${damage.join('\n  ')}`)
    const left = await countRows(tx, userId)
    if (left !== 0) throw new CheckFailed('rows remained', `${left} row(s) of the user remained, so nothing was deleted`)
    return deleted
  }, {
    // One snapshot for both fingerprints. Under READ COMMITTED another user's
    // sync committing between them looked like damage, and rolled the
    // deletion back. The price: a concurrent write to a row this deletes
    // fails it with a serialization error, which the caller retries.
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 120_000,
    maxWait: 15_000,
  })
}

export async function deleteUserData(userId: string, deps: DeletionDeps): Promise<DeletionReport> {
  assertDeletable(userId)
  const db = deps.db ?? defaultPrisma

  // 1. Ban: no new sessions, existing ones revoked.
  let clerkGone = false
  try {
    await deps.clerk.banUser(userId)
  } catch (err) {
    if (!isClerkNotFound(err)) throw err
    clerkGone = true
  }
  const unban = async () => {
    if (clerkGone) return
    try {
      await deps.clerk.unbanUser(userId)
    } catch {
      Sentry.captureMessage('account deletion: stopped, but the user could not be unbanned', {
        level: 'error', extra: { clerkUserId: userId },
      })
    }
  }

  // Part-done: stay banned, report what finishing it needs, tell the user it's underway.
  const incomplete = (extra: Record<string, unknown>): never => {
    Sentry.captureMessage(DELETION_INCOMPLETE, { level: 'error', extra: { clerkUserId: userId, ...extra } })
    throw new DeletionUnderway()
  }

  // 2. Plaid: every Item, before any row goes.
  // In link order, so a partial failure always stops at the same Item: the
  // item_id reported to Sentry, and the tests, don't depend on row order.
  const items = await db.plaidItem.findMany({
    where: { userId },
    select: { itemId: true, accessToken: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  let removedAtPlaid = 0
  for (const item of items) {
    try {
      await removeItemAtPlaid(deps.plaidClient, item.accessToken)
      removedAtPlaid++
    } catch (err: any) {
      const errorCode = err?.response?.data?.error_code ?? null
      if (removedAtPlaid > 0) incomplete({ stage: 'plaid', itemId: item.itemId, errorCode })
      Sentry.captureMessage('account deletion: stopped, an Item could not be removed at Plaid', {
        level: 'error', extra: { itemId: item.itemId, errorCode },
      })
      await unban()
      throw new DeletionError(500, 'Your bank connection could not be removed, so nothing was deleted. Please try again.')
    }
  }

  // 3. Every row, in one transaction, everyone else provably untouched.
  let rowsDeleted: Record<string, number> | undefined
  for (let attempt = 1; !rowsDeleted; attempt++) {
    try {
      rowsDeleted = await deleteRowsOnce(db, userId, attempt, deps.hooks)
    } catch (err: any) {
      if (isConflict(err) && attempt < ROW_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, ROW_RETRY_DELAYS_MS[attempt - 1]))
        continue
      }
      // The reason, never the message: a check's message names other users' row counts.
      const failure = {
        stage: 'rows',
        reason: err instanceof CheckFailed ? err.reason : isConflict(err) ? 'conflict' : 'error',
        attempts: attempt,
        prismaCode: err?.code ?? null,
        pgCode: err?.meta?.code ?? err?.cause?.code ?? null,
      }
      if (removedAtPlaid > 0) incomplete(failure)
      Sentry.captureMessage('account deletion: stopped before anything irreversible, user unbanned', {
        level: 'error', extra: { clerkUserId: userId, ...failure },
      })
      await unban()
      throw new DeletionError(500, "Deletion didn't finish, and nothing was deleted. Please try again.")
    }
  }

  if (deps.hooks?.beforeClerkDelete) await deps.hooks.beforeClerkDelete()

  // 4. The Clerk account.
  let clerkDeleted = clerkGone
  if (!clerkGone) {
    try {
      await deps.clerk.deleteUser(userId)
      clerkDeleted = true
    } catch (err) {
      if (isClerkNotFound(err)) {
        clerkDeleted = true
      } else {
        Sentry.captureMessage('account deletion: data deleted, Clerk account still to delete — rerun the deletion', {
          level: 'error', extra: { clerkUserId: userId },
        })
      }
    }
  }

  // 5. Second sweep: anything written since the transaction.
  const swept = await deleteAll(db, userId)
  const sweptAfter = Object.values(swept).reduce((s, n) => s + n, 0)
  const left = await countRows(db, userId)
  if (left !== 0) {
    Sentry.captureMessage('account deletion: rows remained after the second sweep', {
      level: 'error', extra: { clerkUserId: userId, rows: left },
    })
  }

  return { itemsRemoved: items.length, rowsDeleted: rowsDeleted!, clerkDeleted, sweptAfter }
}
