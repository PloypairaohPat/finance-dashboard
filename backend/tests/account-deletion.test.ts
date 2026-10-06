// ─────────────────────────────────────────────────────────────────
//  "Delete account and all data": the shared deletion service, its endpoint
//  (DELETE /user) and the guard its script uses.
//
//  Order: ban in Clerk (sessions revoked, so the user's own requests can't
//  recreate data) → /item/remove at Plaid for every Item → every row in one
//  transaction, with every other user's fingerprint checked identical →
//  delete the Clerk account → sweep again for anything recreated since.
//
//  All ids, names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
}))

import request from 'supertest'
import { clerkClient } from '@clerk/express'
import { app, plaidClient } from '../src/app'
import { plaidClient as controllerPlaid } from '../src/lib/plaidClient'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { NON_DEMO_TABLES, takeBaseline } from '../scripts/lib/non-demo-baseline'
import {
  DELETE_CONFIRMATION, DELETION_INCOMPLETE, DELETION_ORDER, DELETION_UNDERWAY_MESSAGE, DeletionError,
  DeletionUnderway, ROW_ATTEMPTS, assertDeletable, deleteUserData,
} from '../src/services/accountDeletion.service'

const A = 'deletion-test-user-a'
const B = 'deletion-test-user-b'
const C = 'deletion-test-user-c'
const clerk = clerkClient.users as unknown as Record<'banUser' | 'unbanUser' | 'deleteUser', ReturnType<typeof vi.fn>>
const itemRemove = (plaidClient as any).itemRemove as ReturnType<typeof vi.fn>

/** A user with a row in every table, soft-deleted rows included. */
async function makeUser(id: string) {
  await prisma.user.create({ data: { id, email: `${id}@deletion-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`access-token-${id}`), institutionName: 'Test Bank' } })
  const account = await prisma.account.create({ data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-acct`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' } })
  const tx = await prisma.transaction.create({ data: { userId: id, accountId: account.id, plaidTransactionId: `${id}-tx-1`, date: new Date(), amount: '12.00', name: 'SHOP', tags: ['t'], notes: 'n', rawJson: { name: 'SHOP' } } })
  await prisma.transaction.create({ data: { userId: id, accountId: account.id, plaidTransactionId: `${id}-tx-2`, date: new Date(), amount: '3.00', name: 'GONE', deletedAt: new Date() } })
  await prisma.subscriptionMark.create({ data: { userId: id, transactionId: tx.id } })
  await prisma.budget.create({ data: { userId: id, category: 'Shopping', monthlyLimit: '100.00' } })
  await prisma.balanceSnapshot.create({ data: { userId: id, accountId: account.plaidAccountId, accountName: 'Checking', accountType: 'depository', currentBalance: '10.00', date: new Date() } })
  await prisma.alert.create({ data: { userId: id, kind: 'low_balance', fingerprint: `${id}-a1`, severity: 'medium', title: 't', body: 'b' } })
  await prisma.alert.create({ data: { userId: id, kind: 'low_balance', fingerprint: `${id}-a2`, severity: 'medium', title: 't', body: 'b', deletedAt: new Date() } })
  await prisma.goal.create({ data: { userId: id, type: 'savings', name: 'g', targetAmount: '50.00' } })
  await prisma.goal.create({ data: { userId: id, type: 'savings', name: 'g2', targetAmount: '50.00', deletedAt: new Date() } })
  await prisma.recurringStream.create({
    data: {
      userId: id, plaidItemId: item.id, streamId: `FAKE-${id}-stream`, plaidAccountId: account.plaidAccountId,
      direction: 'outflow', description: 'STREAM', frequency: 'MONTHLY', status: 'MATURE', isActive: true,
      firstDate: new Date(), lastDate: new Date(), lastAmount: '12.00', plaidTransactionIds: [`${id}-tx-1`], plaidUpdatedAt: new Date(),
    },
  })
}

/** Rows the user has in every table that carries a user. */
async function countsOf(id: string) {
  const out: Record<string, number> = {}
  for (const [table, owner] of NON_DEMO_TABLES) {
    const [r] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${owner}" = $1`, id)
    out[table] = r.n
  }
  return out
}
const empty = Object.fromEntries(NON_DEMO_TABLES.map(([t]) => [t, 0]))

async function wipe(id: string) {
  for (const t of ['subscriptionMark', 'transaction', 'account', 'recurringStream', 'plaidItem', 'budget', 'balanceSnapshot', 'alert', 'goal'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id } })
}

/** A second Item, so one can leave Plaid and the next fail. */
async function addItem(id: string) {
  await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item-2`, accessToken: encrypt(`access-token-${id}-2`), institutionName: 'Test Bank' } })
}
const plaidDown = () => Object.assign(new Error('boom'), { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } })

/** The DELETION_INCOMPLETE reports, as their extras. */
const incompleteReports = () => sentry.captureMessage.mock.calls.filter((c) => c[0] === DELETION_INCOMPLETE).map((c) => c[1].extra)

/**
 * A write to one of A's rows from another connection, committed after the
 * deletion's snapshot and before it deletes that row: Postgres refuses the
 * delete under REPEATABLE READ (40001), as a concurrent sync's write would.
 */
const conflictingWrite = () => prisma.budget.updateMany({ where: { userId: A }, data: { monthlyLimit: '7.00' } })

const deps = (extra: object = {}) => ({ plaidClient, clerk: clerkClient.users as any, ...extra })

beforeEach(async () => {
  await wipe(A); await wipe(B)
  await makeUser(A); await makeUser(B)
  for (const f of Object.values(clerk)) { f.mockReset(); f.mockResolvedValue({}) }
  itemRemove.mockReset(); itemRemove.mockResolvedValue({ data: {} })
  sentry.captureMessage.mockClear(); sentry.captureException.mockClear()
})
afterAll(async () => { await wipe(A); await wipe(B) })

describe('deleteUserData', () => {
  it('1. empties every table for the user, soft-deleted rows included, and the list covers every user table', async () => {
    expect(new Set(DELETION_ORDER.map(([t]) => t))).toEqual(new Set(NON_DEMO_TABLES.map(([t]) => t)))
    const report = await deleteUserData(A, deps())
    expect(await countsOf(A)).toEqual(empty)
    expect(report).toMatchObject({ itemsRemoved: 1, clerkDeleted: true })
    expect(clerk.banUser).toHaveBeenCalledWith(A)
    expect(clerk.deleteUser).toHaveBeenCalledWith(A)
    expect(clerk.banUser.mock.invocationCallOrder[0]).toBeLessThan(itemRemove.mock.invocationCallOrder[0])
    expect(itemRemove.mock.invocationCallOrder[0]).toBeLessThan(clerk.deleteUser.mock.invocationCallOrder[0])
  })

  it('2. leaves every other user identical, and rolls back if anything else changed', async () => {
    const before = await takeBaseline(prisma, A)
    await deleteUserData(A, deps())
    expect(await takeBaseline(prisma, A)).toEqual(before)

    // A deletion that touches someone else must not commit. The Item already
    // left Plaid, so the user stays banned and it's reported to finish by hand.
    await wipe(A); await makeUser(A)
    const aBefore = await countsOf(A)
    await expect(deleteUserData(A, deps({
      hooks: { insideTransaction: (tx: any) => tx.budget.deleteMany({ where: { userId: B } }) },
    }))).rejects.toBeInstanceOf(DeletionUnderway)
    expect(await countsOf(A)).toEqual(aBefore)
    expect((await countsOf(B)).Budget).toBe(1)
    expect(clerk.unbanUser).not.toHaveBeenCalled()
    expect(clerk.deleteUser).toHaveBeenCalledTimes(1) // only the first, successful deletion
    // The reason, not the message: that names other users' row counts. Not retried.
    expect(incompleteReports()).toEqual([expect.objectContaining({ clerkUserId: A, stage: 'rows', reason: 'other users changed', attempts: 1 })])
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toMatch(/row\(s\)|rows changed/)
  })

  it('2c. a conflicting write on the first attempt is retried, and the second attempt deletes', async () => {
    const attempts: number[] = []
    const report = await deleteUserData(A, deps({
      hooks: {
        beforeDelete: async (attempt: number) => {
          attempts.push(attempt)
          if (attempt !== 1) return
          await conflictingWrite()
          // Another user's write lands too: only a baseline taken fresh on
          // attempt 2 includes it, so a reused one would read it as damage.
          await prisma.budget.create({ data: { userId: B, category: 'Travel', monthlyLimit: '5.00' } })
        },
      },
    }))
    expect(attempts).toEqual([1, 2])
    expect((await countsOf(B)).Budget).toBe(2)
    expect(report.clerkDeleted).toBe(true)
    expect(await countsOf(A)).toEqual(empty)
    // Only the transaction re-ran: one ban, one Plaid removal, nothing reported.
    expect(clerk.banUser).toHaveBeenCalledTimes(1)
    expect(itemRemove).toHaveBeenCalledTimes(1)
    expect(clerk.unbanUser).not.toHaveBeenCalled()
    expect(incompleteReports()).toEqual([])
  })

  it('2d. a conflict on every attempt stops after the last, stays banned, and reports what finishing it needs', async () => {
    const before = await countsOf(A)
    const attempts: number[] = []
    await expect(deleteUserData(A, deps({
      hooks: { beforeDelete: async (attempt: number) => { attempts.push(attempt); await conflictingWrite() } },
    }))).rejects.toBeInstanceOf(DeletionUnderway)
    expect(attempts).toEqual(Array.from({ length: ROW_ATTEMPTS }, (_, i) => i + 1))
    expect(await countsOf(A)).toEqual(before)
    expect(clerk.unbanUser).not.toHaveBeenCalled()
    expect(clerk.deleteUser).not.toHaveBeenCalled()
    expect(itemRemove).toHaveBeenCalledTimes(1)
    expect(incompleteReports()).toEqual([{ clerkUserId: A, stage: 'rows', reason: 'conflict', attempts: ROW_ATTEMPTS, prismaCode: 'P2034', pgCode: null }])
  })

  it('2e. a failure before any Item left Plaid unbans and asks to try again', async () => {
    // A user with no Items: nothing irreversible happens before the transaction.
    await wipe(C)
    await prisma.user.create({ data: { id: C, email: `${C}@deletion-test.local` } })
    await prisma.budget.create({ data: { userId: C, category: 'Shopping', monthlyLimit: '100.00' } })
    const before = await countsOf(C)
    const err = await deleteUserData(C, deps({
      hooks: { insideTransaction: (tx: any) => tx.goal.deleteMany({ where: { userId: B } }) },
    })).catch((e) => e)
    expect(err).toBeInstanceOf(DeletionError)
    expect(err.message).toMatch(/nothing was deleted\. Please try again/)
    expect(await countsOf(C)).toEqual(before)
    expect(clerk.unbanUser).toHaveBeenCalledWith(C)
    expect(itemRemove).not.toHaveBeenCalled()
    await wipe(C)
    expect(incompleteReports()).toEqual([])
  })

  it("2b. another user's write committed during the deletion doesn't abort it (one snapshot)", async () => {
    const res = await deleteUserData(A, deps({
      hooks: {
        // Committed by another connection while the deletion's transaction is open.
        insideTransaction: () => prisma.budget.create({ data: { userId: B, category: 'Travel', monthlyLimit: '5.00' } }),
      },
    }))
    expect(res.clerkDeleted).toBe(true)
    expect(await countsOf(A)).toEqual(empty)
    expect((await countsOf(B)).Budget).toBe(2)
  })

  it('3. refuses the demo user, through the service and the guard the script uses', async () => {
    await expect(deleteUserData('demo-user', deps())).rejects.toBeInstanceOf(DeletionError)
    expect(() => assertDeletable('demo-user')).toThrow(DeletionError)
    expect(() => assertDeletable('')).toThrow(DeletionError)
    expect(clerk.banUser).not.toHaveBeenCalled()
  })

  it('4. stops on a Plaid failure: nothing deleted, unbanned, the item_id (never the token) to Sentry', async () => {
    itemRemove.mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } }))
    const before = await countsOf(A)
    await expect(deleteUserData(A, deps())).rejects.toThrow()
    expect(await countsOf(A)).toEqual(before)
    expect(clerk.unbanUser).toHaveBeenCalledWith(A)
    expect(clerk.deleteUser).not.toHaveBeenCalled()
    const reported = JSON.stringify(sentry.captureMessage.mock.calls)
    expect(reported).toContain(`${A}-item`)
    expect(reported).not.toContain(`access-token-${A}`)
  })

  it('4b. one Item removed at Plaid and the next not: stays banned, reports, nothing deleted', async () => {
    await addItem(A)
    itemRemove.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(plaidDown())
    const before = await countsOf(A)
    await expect(deleteUserData(A, deps())).rejects.toBeInstanceOf(DeletionUnderway)
    expect(itemRemove).toHaveBeenCalledTimes(2)
    expect(await countsOf(A)).toEqual(before)
    expect(clerk.unbanUser).not.toHaveBeenCalled()
    expect(incompleteReports()).toEqual([{ clerkUserId: A, stage: 'plaid', itemId: `${A}-item-2`, errorCode: 'INTERNAL_SERVER_ERROR' }])
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toContain('access-token')
  })

  it('5. carries on when Plaid says the Item is already gone', async () => {
    itemRemove.mockRejectedValueOnce(Object.assign(new Error('gone'), { response: { data: { error_code: 'ITEM_NOT_FOUND' } } }))
    await deleteUserData(A, deps())
    expect(await countsOf(A)).toEqual(empty)
  })

  it('6. a Clerk deletion failure leaves the data deleted and the user banned; a rerun finishes it', async () => {
    clerk.deleteUser.mockRejectedValueOnce(new Error('clerk down'))
    const first = await deleteUserData(A, deps())
    expect(first.clerkDeleted).toBe(false)
    expect(await countsOf(A)).toEqual(empty)
    expect(clerk.unbanUser).not.toHaveBeenCalled()
    expect(JSON.stringify(sentry.captureMessage.mock.calls)).toContain(A)

    const second = await deleteUserData(A, deps())
    expect(second).toMatchObject({ clerkDeleted: true, itemsRemoved: 0 })
    expect(clerk.deleteUser).toHaveBeenCalledTimes(2)
  })

  it('9. a row recreated after the transaction is removed by the second sweep', async () => {
    const report = await deleteUserData(A, deps({
      hooks: {
        beforeClerkDelete: async () => {
          await prisma.user.create({ data: { id: A } })
          await prisma.budget.create({ data: { userId: A, category: 'Travel', monthlyLimit: '5.00' } })
        },
      },
    }))
    expect(report.sweptAfter).toBe(2)
    expect(await countsOf(A)).toEqual(empty)
  })

  it('10. afterwards nothing can be written for the deleted user', async () => {
    await deleteUserData(A, deps())
    await expect(prisma.alert.create({ data: { userId: A, kind: 'low_balance', fingerprint: 'late', severity: 'medium', title: 't', body: 'b' } })).rejects.toThrow()
  })
})

describe('DELETE /user', () => {
  const del = (userId: string, body: object) => request(app).delete('/user').set('X-Test-User', userId).send(body)

  it('7. needs the phrase, checked on the server: missing or wrong deletes nothing', async () => {
    const before = await countsOf(A)
    for (const body of [{}, { confirmation: 'delete' }, { confirmation: 'DELETE MY ACCOUNT' }]) {
      const res = await del(A, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await countsOf(A)).toEqual(before)
    expect(clerk.banUser).not.toHaveBeenCalled()
  })

  it('deletes the caller with the phrase, ignoring case and surrounding spaces', async () => {
    const res = await del(A, { confirmation: `  ${DELETE_CONFIRMATION.toUpperCase()} ` })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ deleted: true, accountDeleted: true })
    expect(await countsOf(A)).toEqual(empty)
  })

  it('a part-done deletion answers "underway", not an error asking to try again', async () => {
    await addItem(A)
    // DELETE /user uses src/lib/plaidClient's instance, not the app's.
    const remove = (controllerPlaid as any).itemRemove as ReturnType<typeof vi.fn>
    remove.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(plaidDown())
    const res = await del(A, { confirmation: DELETE_CONFIRMATION })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: false, accountDeleted: false, pending: true, message: DELETION_UNDERWAY_MESSAGE })
    expect(clerk.unbanUser).not.toHaveBeenCalled()
  })

  it('8. deletes only the caller: another user named in the body is ignored and left identical', async () => {
    const aBefore = await takeBaseline(prisma, B)
    const res = await del(B, { confirmation: DELETE_CONFIRMATION, userId: A })
    expect(res.status).toBe(200)
    expect(await countsOf(B)).toEqual(empty)
    expect(await takeBaseline(prisma, B)).toEqual(aBefore)
  })

  it('3. is blocked in demo mode, and the demo user is untouched', async () => {
    const demoBefore = await countsOf('demo-user')
    const res = await request(app).delete('/user').set('X-Demo-Mode', '1').send({ confirmation: DELETE_CONFIRMATION })
    expect(res.body).toMatchObject({ demo: true, ok: false })
    expect(await countsOf('demo-user')).toEqual(demoBefore)
    expect(clerk.banUser).not.toHaveBeenCalled()
  })
})
