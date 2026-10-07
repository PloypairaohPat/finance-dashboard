// ─────────────────────────────────────────────────────────────────
//  A mark's kind (M7.6 PR 4): "confirmed" or "dismissed", enforced by the
//  database, existing marks reading as confirmations, and nothing that
//  reads marks today treating a dismissal as a subscription.
//  Columns only: no code creates a dismissal yet. All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { composeSubscriptions } from '../src/services/streamComposition.service'
import { membershipOf } from '../src/services/subscriptionMarks.service'

const A = 'mark-kind-user-a'
const B = 'mark-kind-user-b'
const txOf: Record<string, string> = {}

async function wipe(id: string) {
  await prisma.subscriptionMark.deleteMany({ where: { userId: id } })
  await prisma.transaction.deleteMany({ where: { userId: id } })
  await prisma.account.deleteMany({ where: { userId: id } })
  await prisma.plaidItem.deleteMany({ where: { userId: id } })
  await prisma.user.deleteMany({ where: { id } })
}

/** A user with one posted gym charge on a card: markable, and too lone for detection. */
async function makeUser(id: string) {
  await prisma.user.create({ data: { id, email: `${id}@mark-kind-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`fake-${id}`), institutionName: `${id}-Bank` } })
  const account = await prisma.account.create({
    data: { userId: id, plaidItemId: item.id, plaidAccountId: `${id}-card`, name: 'Card', type: 'credit', subtype: 'credit card', isoCurrencyCode: 'USD' },
  })
  const primary = 'PERSONAL_CARE', detailed = 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'
  const t = await prisma.transaction.create({
    data: {
      userId: id, accountId: account.id, plaidTransactionId: `${id}-tx`, date: new Date(Date.now() - 10 * 86_400_000),
      amount: '30.00', name: 'GYM CO', cleanName: 'GYM CO', categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD',
      rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' }, counterparties: [] },
    },
  })
  txOf[id] = t.id
}

const markedSubscriptions = async (userId: string) => (await composeSubscriptions(userId)).subscriptions.filter((s) => s.mark)

beforeEach(async () => {
  await wipe(A); await wipe(B)
  await makeUser(A); await makeUser(B)
})
afterAll(async () => { await wipe(A); await wipe(B) })

describe('the database', () => {
  it('reads a mark written without a kind as a confirmation (existing marks)', async () => {
    await prisma.$executeRaw`INSERT INTO "SubscriptionMark" (id, "userId", "transactionId") VALUES ('mark-kind-legacy', ${A}, ${txOf[A]})`
    const row = await prisma.subscriptionMark.findUniqueOrThrow({ where: { id: 'mark-kind-legacy' } })
    expect(row.kind).toBe('confirmed')
  })

  it('refuses a kind that is neither confirmed nor dismissed', async () => {
    await expect(prisma.$executeRaw`INSERT INTO "SubscriptionMark" (id, "userId", "transactionId", kind) VALUES ('mark-kind-bad', ${A}, ${txOf[A]}, 'maybe')`)
      .rejects.toThrow()
    expect(await prisma.subscriptionMark.count({ where: { userId: A } })).toBe(0)
  })

  it('refuses a charge both confirmed and dismissed: one answer per charge', async () => {
    await prisma.subscriptionMark.create({ data: { userId: A, transactionId: txOf[A], kind: 'confirmed' } })
    await expect(prisma.subscriptionMark.create({ data: { userId: A, transactionId: txOf[A], kind: 'dismissed' } }))
      .rejects.toMatchObject({ code: 'P2002' })
  })

  it("refuses a dismissal on another user's transaction, as it does a mark", async () => {
    await expect(prisma.subscriptionMark.create({ data: { userId: A, transactionId: txOf[B], kind: 'dismissed' } })).rejects.toThrow()
    expect(await prisma.subscriptionMark.count({ where: { transactionId: txOf[B] } })).toBe(0)
  })
})

describe('what reads marks today', () => {
  it('a confirmation shows as a marked subscription, and POST creates one', async () => {
    const res = await request(app).post('/subscriptions/marks').set('X-Test-User', A).send({ transactionId: txOf[A] })
    expect(res.status).toBe(201)
    expect((await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: A } })).kind).toBe('confirmed')
    expect(await markedSubscriptions(A)).toHaveLength(1)
    expect((await membershipOf(A, txOf[A])).state).toBe('marked')
  })

  it('a dismissal is never read as a subscription', async () => {
    await prisma.subscriptionMark.create({ data: { userId: A, transactionId: txOf[A], kind: 'dismissed' } })
    expect(await markedSubscriptions(A)).toHaveLength(0)
    expect((await membershipOf(A, txOf[A])).state).not.toBe('marked')
  })

  it('un-marking never removes a dismissal', async () => {
    const dismissal = await prisma.subscriptionMark.create({ data: { userId: A, transactionId: txOf[A], kind: 'dismissed' } })
    const res = await request(app).delete(`/subscriptions/marks/${dismissal.id}`).set('X-Test-User', A)
    expect(res.status).toBe(404)
    expect(await prisma.subscriptionMark.count({ where: { id: dismissal.id } })).toBe(1)
  })
})
