// ─────────────────────────────────────────────────────────────────
//  Confirmations whose charge changed after the user confirmed it (M7.6's
//  open follow-up, docs/m7.6-audit.md).
//
//  A charge feeds an amount (last amount, monthly amount, the price chip,
//  price-up) only if it's live, posted and spending; a date (last charge, the
//  fallback next date) only if it's live and spending, pending allowed. A
//  confirmation whose series has no such charge left stays where the user put
//  it, flagged notCounted, outside every total, and can still be removed. A
//  stream reads verdicts from its removed charges too, so a confirmation or
//  dismissal on a charge Plaid removed still applies, with no ghost.
//  All names, ids, amounts and dates are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { composeSubscriptions, type ComposedAnalysis } from '../src/services/streamComposition.service'
import { sortUserStreams } from '../src/services/streamSorting.service'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'
import type { DetectedAlert, DetectorContext } from '../src/services/alerts/types'

const PREFIX = 'stale-conf-test'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (d: number) => new Date(today - d * DAY)

type Code = readonly [string, string]
const GYM: Code = ['PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS']
const TO_SAVINGS: Code = ['TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS']
const TO_PERSON: Code = ['TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER']
const CARD_PAYMENT: Code = ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT']

interface World { userId: string; itemId: string; accountId: string; n: number }

async function world(suffix: string): Promise<World> {
  const userId = `${PREFIX}-${suffix}`
  await prisma.user.create({ data: { id: userId, email: `${userId}@stale-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-${userId}`), institutionName: 'Test Bank' } })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-checking`, name: 'Checking', type: 'depository', subtype: 'checking', isoCurrencyCode: 'USD' },
  })
  return { userId, itemId: item.id, accountId: account.id, n: 0 }
}

async function charge(w: World, daysAgo: number, amount: number, name: string, code: Code, o: { pending?: boolean; cps?: object[]; entity?: string } = {}) {
  const plaidTransactionId = `${w.userId}-tx-${++w.n}`
  const t = await prisma.transaction.create({
    data: {
      userId: w.userId, accountId: w.accountId, plaidTransactionId, date: ago(daysAgo), amount: amount.toFixed(2),
      name, cleanName: name, categoryPrimary: code[0], categoryDetailed: code[1], pending: o.pending ?? false, isoCurrencyCode: 'USD',
      merchantEntityId: o.entity ?? null, counterpartyEntities: o.entity ? [`merchant:${o.entity}`] : [],
      rawJson: { personal_finance_category: { primary: code[0], detailed: code[1], confidence_level: 'VERY_HIGH' }, counterparties: o.cps ?? [] },
    },
  })
  return { id: t.id, plaidId: plaidTransactionId }
}

const stream = (w: World, charges: Array<{ plaidId: string }>, name: string, code: Code) => prisma.recurringStream.create({
  data: {
    userId: w.userId, plaidItemId: w.itemId, streamId: `FAKE-${w.userId}-${++w.n}`, plaidAccountId: `${w.userId}-checking`,
    direction: 'outflow', description: name, merchantName: name, pfcPrimary: code[0], pfcDetailed: code[1],
    frequency: 'MONTHLY', status: 'MATURE', isActive: true, firstDate: ago(90), lastDate: ago(5),
    plaidTransactionIds: charges.map((c) => c.plaidId), plaidUpdatedAt: new Date(),
  },
})

const confirm = (w: World, transactionId: string, kind: 'confirmed' | 'dismissed' = 'confirmed') =>
  prisma.subscriptionMark.create({ data: { userId: w.userId, transactionId, kind } })
const remove = (id: string) => prisma.transaction.update({ where: { id }, data: { deletedAt: new Date() } })
const recategorise = (id: string, code: Code) => prisma.transaction.update({ where: { id }, data: { categoryPrimary: code[0], categoryDetailed: code[1] } })

const compose = (w: World) => composeSubscriptions(w.userId, now)
const shown = (r: ComposedAnalysis) => [...r.subscriptions, ...r.bills]
const priceUp = (r: ComposedAnalysis) =>
  detectSubscriptionPriceUp({ now, subscriptions: { ok: true, analysis: r } } as unknown as DetectorContext) as DetectedAlert[]

afterAll(async () => {
  const where = { userId: { startsWith: PREFIX } }
  await prisma.subscriptionMark.deleteMany({ where })
  await prisma.recurringStream.deleteMany({ where })
  await prisma.transaction.deleteMany({ where })
  await prisma.account.deleteMany({ where })
  await prisma.plaidItem.deleteMany({ where })
  await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } })
})

describe('a confirmation whose charge stopped being spending (sync recategorised it)', () => {
  it('alone: flagged in place, not counted, no next date, no price-up', async () => {
    const w = await world('reclass-alone')
    const c = await charge(w, 10, 40, 'IRONGYM', GYM, { entity: 'FAKE-ent-irongym' })
    await confirm(w, c.id)
    await recategorise(c.id, TO_SAVINGS)
    const r = await compose(w)
    expect(r.subscriptions).toHaveLength(1)
    expect(r.subscriptions[0]).toMatchObject({ notCounted: { reason: 'not-spending' }, mark: expect.anything(), nextChargeDate: null, priceChange: null })
    expect(r.totals.monthlyAll).toBe(0)
    expect(r.upcoming).toEqual([])
  })

  it("in a series: its amount and date are dropped, the series' other charges still count", async () => {
    const w = await world('reclass-series')
    const e = 'FAKE-ent-gymseries'
    await charge(w, 65, 40, 'GYMSERIES', GYM, { entity: e })
    await charge(w, 35, 40, 'GYMSERIES', GYM, { entity: e })
    const latest = await charge(w, 5, 400, 'GYMSERIES', GYM, { entity: e })
    await confirm(w, latest.id)
    await recategorise(latest.id, TO_SAVINGS)
    const r = await compose(w)
    const [s] = r.subscriptions
    expect(s.notCounted).toBeUndefined()
    expect(s).toMatchObject({ lastAmount: 40, lastDate: ago(35).toISOString().slice(0, 10), priceChange: null })
    expect(priceUp(r)).toEqual([])
  })
})

describe('a confirmation on a charge Plaid removed (sync soft-deleted it)', () => {
  it('alone: flagged in place as removed, not counted', async () => {
    const w = await world('removed-alone')
    const c = await charge(w, 10, 40, 'IRONGYM', GYM, { entity: 'FAKE-ent-irongym2' })
    await confirm(w, c.id)
    await remove(c.id)
    const r = await compose(w)
    expect(r.subscriptions.map((s) => s.notCounted)).toEqual([{ reason: 'removed' }])
    expect(r.totals.monthlyAll).toBe(0)
  })

  it('on a confirmed bill stream: the stream stays confirmed in Bills, and no ghost appears in Subscriptions', async () => {
    const w = await world('removed-stream')
    const cs = [await charge(w, 65, 215, 'R OKAFOR', TO_PERSON), await charge(w, 35, 215, 'R OKAFOR', TO_PERSON), await charge(w, 5, 215, 'R OKAFOR', TO_PERSON)]
    await stream(w, cs, 'R OKAFOR', TO_PERSON)
    const m = await confirm(w, cs[2].id)
    expect((await compose(w)).bills.map((s) => s.mark?.id)).toEqual([m.id]) // confirmed into Bills
    await remove(cs[2].id)
    const r = await compose(w)
    expect(r.bills.map((s) => s.mark?.id)).toEqual([m.id])
    expect(r.subscriptions).toEqual([])
    expect(r.suggested).toEqual([])
  })

  it("a removed confirmed charge under another name is still the stream's: no extra row of its own", async () => {
    const w = await world('removed-renamed')
    const cs = [
      await charge(w, 65, 215, 'R OKAFOR', TO_PERSON), await charge(w, 35, 215, 'R OKAFOR', TO_PERSON),
      // The confirmed charge carried another label (as a pending row can) before the bank removed it.
      await charge(w, 5, 215, 'ONLINE TRANSFER 0042', TO_PERSON),
    ]
    await stream(w, cs, 'R OKAFOR', TO_PERSON)
    const m = await confirm(w, cs[2].id)
    await remove(cs[2].id)
    const r = await compose(w)
    expect(r.bills.map((s) => s.mark?.id)).toEqual([m.id])
    expect(r.subscriptions).toEqual([])
  })

  it('a dismissal on a removed charge keeps the stream dismissed', async () => {
    const w = await world('removed-dismissal')
    const cs = [await charge(w, 65, 80, 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE']), await charge(w, 35, 80, 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE'])]
    await stream(w, cs, 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE'])
    const d = await confirm(w, cs[1].id, 'dismissed')
    await remove(cs[1].id)
    const r = await compose(w)
    expect(r.suggested).toEqual([])
    expect(r.dismissed.map((s) => s.mark?.id)).toEqual([d.id])
  })

  it('Unmark on it goes through DELETE /subscriptions/verdicts/:id and succeeds', async () => {
    const w = await world('removed-unmark')
    const c = await charge(w, 10, 40, 'IRONGYM', GYM, { entity: 'FAKE-ent-irongym3' })
    const m = await confirm(w, c.id)
    await remove(c.id)
    expect((await request(app).delete(`/subscriptions/verdicts/${m.id}`).set('X-Test-User', w.userId)).status).toBe(200)
    expect(await prisma.subscriptionMark.findUnique({ where: { id: m.id } })).toBeNull()
    expect(shown(await compose(w))).toEqual([])
  })
})

describe('a newly linked card turns confirmed card payments into transfers', () => {
  it('flagged in place as not spending, not counted', async () => {
    const w = await world('linked-card')
    const toOther = [{ name: 'Other Bank', type: 'financial_institution' }]
    const c = await charge(w, 10, 900, 'OTHER BANK CARD PAYMENT', CARD_PAYMENT, { cps: toOther })
    await confirm(w, c.id)
    expect(shown(await compose(w))[0].notCounted).toBeUndefined() // a payment to a card Ledger can't see: spending (D3)
    // The user links that bank's card: the payment is now a card payment.
    const other = await prisma.plaidItem.create({ data: { userId: w.userId, itemId: `${w.userId}-item-2`, accessToken: encrypt('fake-2'), institutionName: 'Other Bank' } })
    await prisma.account.create({ data: { userId: w.userId, plaidItemId: other.id, plaidAccountId: `${w.userId}-card`, name: 'Card', type: 'credit', subtype: 'credit card', isoCurrencyCode: 'USD' } })
    const r = await compose(w)
    expect(shown(r).map((s) => s.notCounted)).toEqual([{ reason: 'not-spending' }])
    expect(r.totals.monthlyAll).toBe(0)
  })
})

describe('a pending charge sets dates, never amounts', () => {
  it('a walked series: its pending, higher newest charge sets the last date, not the amount or a price change', async () => {
    const w = await world('pending-series')
    const e = 'FAKE-ent-pendgym'
    const first = await charge(w, 62, 40, 'PENDGYM', GYM, { entity: e })
    await charge(w, 32, 40, 'PENDGYM', GYM, { entity: e })
    await charge(w, 2, 60, 'PENDGYM', GYM, { entity: e, pending: true })
    await confirm(w, first.id)
    const [s] = (await compose(w)).subscriptions
    expect(s).toMatchObject({ lastAmount: 40, lastDate: ago(2).toISOString().slice(0, 10), lastChargePending: true, priceChange: null, monthlyAmount: 40 })
  })
})

describe('guards', () => {
  it('a confirmed charge the user recategorised as Debt still counts', async () => {
    const w = await world('edit-debt')
    const e = 'FAKE-ent-debtgym'
    await charge(w, 65, 40, 'DEBTGYM', GYM, { entity: e })
    const c = await charge(w, 35, 40, 'DEBTGYM', GYM, { entity: e })
    await charge(w, 5, 40, 'DEBTGYM', GYM, { entity: e })
    await confirm(w, c.id)
    await request(app).put(`/transactions/${c.id}`).set('X-Test-User', w.userId).send({ category: 'Debt' })
    const [s] = (await compose(w)).subscriptions
    expect(s.notCounted).toBeUndefined()
    expect((await compose(w)).totals.monthlySubscriptions).toBe(40)
  })

  it("isolation: another user's removed charge, listed by a stream, never supplies a verdict", async () => {
    const a = await world('iso-a')
    const b = await world('iso-b')
    const bc = await charge(b, 35, 80, 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE'])
    await confirm(b, bc.id, 'dismissed')
    await remove(bc.id)
    const ac = [await charge(a, 65, 80, 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE'])]
    await stream(a, [...ac, bc], 'CLINIC', ['MEDICAL', 'MEDICAL_PRIMARY_CARE'])
    const r = await compose(a)
    expect(r.dismissed).toEqual([])
    expect(r.suggested.map((s) => s.merchant)).toEqual(['CLINIC'])
    // Resolved by the stream's own user only: B's removed row is never one of A's stream's charges.
    expect((await sortUserStreams(a.userId)).flatMap((s) => s.removedChargeIds)).toEqual([])
  })

  it("DELETE /subscriptions/verdicts/:id with another user's verdict on a removed charge is a 404, and the row is unchanged", async () => {
    const a = await world('iso-del-a')
    const b = await world('iso-del-b')
    const bc = await charge(b, 10, 40, 'IRONGYM', GYM)
    const theirs = await confirm(b, bc.id)
    await remove(bc.id)
    expect((await request(app).delete(`/subscriptions/verdicts/${theirs.id}`).set('X-Test-User', a.userId)).status).toBe(404)
    expect(await prisma.subscriptionMark.findUnique({ where: { id: theirs.id } })).toEqual(theirs)
  })
})
