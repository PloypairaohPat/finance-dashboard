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
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { NON_DEMO_TABLES, takeBaseline } from '../scripts/lib/non-demo-baseline'
import {
  DELETE_CONFIRMATION, DELETION_ORDER, DeletionError, assertDeletable, deleteUserData,
} from '../src/services/accountDeletion.service'

const A = 'deletion-test-user-a'
const B = 'deletion-test-user-b'
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
  for (const t of ['subscriptionMark', 'transaction', 'account', 'plaidItem', 'budget', 'balanceSnapshot', 'alert', 'goal'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id } })
}

const deps = (extra: object = {}) => ({ plaidClient, clerk: clerkClient.users as any, ...extra })

beforeEach(async () => {
  await wipe(A); await wipe(B)
  await makeUser(A); await makeUser(B)
  for (const f of Object.values(clerk)) { f.mockReset(); f.mockResolvedValue({}) }
  itemRemove.mockReset(); itemRemove.mockResolvedValue({ data: {} })
  sentry.captureMessage.mockClear()
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

    // A deletion that touches someone else must not commit.
    await wipe(A); await makeUser(A)
    const aBefore = await countsOf(A)
    await expect(deleteUserData(A, deps({
      hooks: { insideTransaction: (tx: any) => tx.budget.deleteMany({ where: { userId: B } }) },
    }))).rejects.toThrow(/other users' rows changed/)
    expect(await countsOf(A)).toEqual(aBefore)
    expect((await countsOf(B)).Budget).toBe(1)
    expect(clerk.unbanUser).toHaveBeenCalledWith(A)
    expect(clerk.deleteUser).toHaveBeenCalledTimes(1) // only the first, successful deletion
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
