// ─────────────────────────────────────────────────────────────────
//  Confirm and Dismiss (M7.6 PR 5c): POST and DELETE /subscriptions/verdicts.
//  One answer per stream, written under the per-user lock; anchored only on
//  a posted, live charge of the caller's; another user's charge or verdict
//  is a 404 and the database is checked unchanged, not only the status.
//  All ids, names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { writeVerdict } from '../src/services/streamVerdicts.service'
import { composeSubscriptions } from '../src/services/streamComposition.service'

const A = 'verdicts-test-user-a'
const B = 'verdicts-test-user-b'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (d: number) => new Date(today - d * DAY)

interface World { userId: string; itemId: string; accountId: string; n: number }
const w: Record<string, World> = {}

async function wipe(id: string) {
  await prisma.subscriptionMark.deleteMany({ where: { userId: id } })
  await prisma.recurringStream.deleteMany({ where: { userId: id } })
  await prisma.transaction.deleteMany({ where: { userId: id } })
  await prisma.account.deleteMany({ where: { userId: id } })
  await prisma.plaidItem.deleteMany({ where: { userId: id } })
  await prisma.user.deleteMany({ where: { id } })
}

async function world(userId: string): Promise<World> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@verdicts-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-${userId}`), institutionName: `${userId}-Bank` } })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-card`, name: 'Card', type: 'credit', subtype: 'credit card', isoCurrencyCode: 'USD' },
  })
  return { userId, itemId: item.id, accountId: account.id, n: 0 }
}

async function charge(x: World, daysAgo: number, o: { amount?: number; pending?: boolean; deleted?: boolean; primary?: string; detailed?: string } = {}) {
  const plaidTransactionId = `${x.userId}-tx-${++x.n}`
  const primary = o.primary ?? 'MEDICAL', detailed = o.detailed ?? 'MEDICAL_PRIMARY_CARE'
  const t = await prisma.transaction.create({
    data: {
      userId: x.userId, accountId: x.accountId, plaidTransactionId, date: ago(daysAgo), amount: (o.amount ?? 40).toFixed(2),
      name: 'CLINIC', cleanName: 'CLINIC', categoryPrimary: primary, categoryDetailed: detailed,
      pending: o.pending ?? false, deletedAt: o.deleted ? new Date() : null, isoCurrencyCode: 'USD',
      rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' }, counterparties: [] },
    },
  })
  return { id: t.id, plaidId: plaidTransactionId }
}

const stream = (x: World, plaidIds: string[]) => prisma.recurringStream.create({
  data: {
    userId: x.userId, plaidItemId: x.itemId, streamId: `FAKE-${x.userId}-${++x.n}`, plaidAccountId: `${x.userId}-card`,
    direction: 'outflow', description: 'CLINIC', merchantName: 'Clinic', pfcPrimary: 'MEDICAL', pfcDetailed: 'MEDICAL_PRIMARY_CARE',
    frequency: 'MONTHLY', status: 'MATURE', isActive: true, firstDate: ago(65), lastDate: ago(5),
    plaidTransactionIds: plaidIds, plaidUpdatedAt: new Date(),
  },
})

const post = (as: string, body: object) => request(app).post('/subscriptions/verdicts').set('X-Test-User', as).send(body)
const del = (as: string, id: string) => request(app).delete(`/subscriptions/verdicts/${id}`).set('X-Test-User', as)
const verdictsOf = (userId: string) => prisma.subscriptionMark.findMany({ where: { userId }, orderBy: { id: 'asc' } })
const everyVerdict = () => prisma.subscriptionMark.findMany({ orderBy: { id: 'asc' } })

/** A's three-charge stream, plus B's own stream with a dismissal on it. */
let c: Array<{ id: string; plaidId: string }>
let bCharges: Array<{ id: string; plaidId: string }>
beforeEach(async () => {
  await wipe(A); await wipe(B)
  w.a = await world(A); w.b = await world(B)
  c = [await charge(w.a, 65), await charge(w.a, 35), await charge(w.a, 5)]
  await stream(w.a, c.map((x) => x.plaidId))
  bCharges = [await charge(w.b, 35), await charge(w.b, 5)]
  await stream(w.b, bCharges.map((x) => x.plaidId))
  await prisma.subscriptionMark.create({ data: { userId: B, transactionId: bCharges[1].id, kind: 'dismissed' } })
})
afterAll(async () => { await wipe(A); await wipe(B) })

describe('POST /subscriptions/verdicts', () => {
  it('refuses a missing transactionId or an unknown verdict with 400, writing nothing', async () => {
    expect((await post(A, { verdict: 'confirmed' })).status).toBe(400)
    expect((await post(A, { transactionId: c[0].id, verdict: 'maybe' })).status).toBe(400)
    expect(await verdictsOf(A)).toEqual([])
  })

  it('confirms a stream charge, and the tab shows the stream confirmed', async () => {
    const res = await post(A, { transactionId: c[1].id, verdict: 'confirmed' })
    expect(res.status).toBe(201)
    expect((await verdictsOf(A)).map((v) => [v.transactionId, v.kind])).toEqual([[c[1].id, 'confirmed']])
    const r = await composeSubscriptions(A, now)
    expect(r.suggested).toEqual([])
    expect(r.subscriptions.map((s) => s.mark?.id)).toEqual([res.body.verdict.id])
  })

  it("one answer per stream: dismissing another of its charges replaces the confirmation", async () => {
    await post(A, { transactionId: c[0].id, verdict: 'confirmed' })
    expect((await post(A, { transactionId: c[2].id, verdict: 'dismissed' })).status).toBe(201)
    expect((await verdictsOf(A)).map((v) => [v.transactionId, v.kind])).toEqual([[c[2].id, 'dismissed']])
  })

  it('confirming a dismissed charge replaces the dismissal', async () => {
    await post(A, { transactionId: c[2].id, verdict: 'dismissed' })
    expect((await post(A, { transactionId: c[2].id, verdict: 'confirmed' })).status).toBe(201)
    expect((await verdictsOf(A)).map((v) => [v.transactionId, v.kind])).toEqual([[c[2].id, 'confirmed']])
  })

  it('a charge in no stream can be confirmed (a mark, as today) but not dismissed', async () => {
    const lone = await charge(w.a, 10)
    expect((await post(A, { transactionId: lone.id, verdict: 'dismissed' })).status).toBe(409)
    expect(await verdictsOf(A)).toEqual([])
    expect((await post(A, { transactionId: lone.id, verdict: 'confirmed' })).status).toBe(201)
    expect((await verdictsOf(A)).map((v) => [v.transactionId, v.kind])).toEqual([[lone.id, 'confirmed']])
  })

  it.each(['confirmed', 'dismissed'])('refuses a pending or a soft-deleted charge with 409 (%s), writing nothing', async (verdict) => {
    const pending = await charge(w.a, 0, { pending: true })
    const deleted = await charge(w.a, 20, { deleted: true })
    await prisma.recurringStream.updateMany({ where: { userId: A }, data: { plaidTransactionIds: [...c.map((x) => x.plaidId), pending.plaidId, deleted.plaidId] } })
    const p = await post(A, { transactionId: pending.id, verdict })
    expect(p.status).toBe(409)
    expect(p.body.error).toMatch(/pending/)
    const d = await post(A, { transactionId: deleted.id, verdict })
    expect(d.status).toBe(409)
    expect(d.body.error).toMatch(/removed/)
    expect(await verdictsOf(A)).toEqual([])
  })

  it('refuses to confirm a charge that is not spending', async () => {
    const payment = await charge(w.a, 15, { amount: -200, primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect((await post(A, { transactionId: payment.id, verdict: 'confirmed' })).status).toBe(409)
    expect(await verdictsOf(A)).toEqual([])
  })

  it("IDOR: confirming or dismissing another user's charge is a 404, and no row anywhere changes", async () => {
    const before = await everyVerdict()
    for (const verdict of ['confirmed', 'dismissed']) {
      for (const t of bCharges) {
        expect((await post(A, { transactionId: t.id, verdict })).status, `${verdict} ${t.id}`).toBe(404)
      }
    }
    expect(await everyVerdict()).toEqual(before)
  })

  it("IDOR: a stream of A's naming B's charges never reaches B's verdicts", async () => {
    await prisma.recurringStream.updateMany({ where: { userId: A }, data: { plaidTransactionIds: [...c.map((x) => x.plaidId), ...bCharges.map((x) => x.plaidId)] } })
    const bBefore = await verdictsOf(B)
    expect((await post(A, { transactionId: c[0].id, verdict: 'dismissed' })).status).toBe(201)
    expect(await verdictsOf(B)).toEqual(bBefore)
  })

  it('serialises two answers on one stream: exactly one survives', async () => {
    const slow = { afterClear: () => new Promise((r) => setTimeout(r, 300)) }
    await Promise.all([
      writeVerdict(A, c[0].id, 'confirmed', slow),
      writeVerdict(A, c[2].id, 'dismissed', slow),
    ])
    expect(await verdictsOf(A)).toHaveLength(1)
  })

  it('is blocked in demo mode, writing nothing', async () => {
    const before = await everyVerdict()
    const res = await request(app).post('/subscriptions/verdicts').set('X-Demo-Mode', '1').send({ transactionId: c[0].id, verdict: 'confirmed' })
    expect(res.body).toMatchObject({ demo: true, ok: false })
    expect(await everyVerdict()).toEqual(before)
  })
})

describe('DELETE /subscriptions/verdicts/:id', () => {
  it('undoes the caller\'s own verdict, and nothing else', async () => {
    const mine = (await post(A, { transactionId: c[0].id, verdict: 'confirmed' })).body.verdict
    const bBefore = await verdictsOf(B)
    expect((await del(A, mine.id)).status).toBe(200)
    expect(await verdictsOf(A)).toEqual([])
    expect(await verdictsOf(B)).toEqual(bBefore)
  })

  it("IDOR (the shape M6.1 found): another user's verdict id is a 404, and that row is unchanged", async () => {
    const theirs = await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: B } })
    const res = await del(A, theirs.id)
    expect(res.status).toBe(404)
    expect(await prisma.subscriptionMark.findUnique({ where: { id: theirs.id } })).toEqual(theirs)
  })

  it('a verdict id that does not exist is a 404', async () => {
    expect((await del(A, 'FAKE-no-such-verdict')).status).toBe(404)
  })

  it('is blocked in demo mode, deleting nothing', async () => {
    const theirs = await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: B } })
    const res = await request(app).delete(`/subscriptions/verdicts/${theirs.id}`).set('X-Demo-Mode', '1')
    expect(res.body).toMatchObject({ demo: true, ok: false })
    expect(await prisma.subscriptionMark.findUnique({ where: { id: theirs.id } })).toEqual(theirs)
  })
})
