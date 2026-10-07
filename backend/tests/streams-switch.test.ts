// ─────────────────────────────────────────────────────────────────
//  M7.6 PR 5e: the tab, the bell and the panel read Plaid's streams.
//
//  GET /subscriptions, the bell's input and membership are the composed
//  result; nothing of one user's streams, suggestions or dismissals reaches
//  another through any of them; and "Mark as subscription" is a confirmation
//  written through the verdict writer. All names, ids and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { loadContext } from '../src/services/alerts/dispatcher'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'

const A = 'switch-test-user-a'
const B = 'switch-test-user-b'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (d: number) => new Date(today - d * DAY)

interface World { userId: string; itemId: string; accountId: string; n: number }
const w: Record<string, World> = {}
type Code = readonly [string, string]
const TV: Code = ['ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES']
const DOCTOR: Code = ['MEDICAL', 'MEDICAL_PRIMARY_CARE']
const PERSON: Code = ['TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER']

async function wipe(id: string) {
  for (const t of ['alert', 'subscriptionMark', 'recurringStream', 'transaction', 'account', 'plaidItem'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: id } })
  }
  await prisma.user.deleteMany({ where: { id } })
}

async function world(userId: string): Promise<World> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@switch-test.local` } })
  const item = await prisma.plaidItem.create({ data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-${userId}`), institutionName: `${userId}-Bank` } })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-acct`, name: 'Checking', type: 'depository', subtype: 'checking', isoCurrencyCode: 'USD' },
  })
  return { userId, itemId: item.id, accountId: account.id, n: 0 }
}

/** Monthly charges of one merchant, oldest first, and Plaid's stream over them. */
async function stream(x: World, name: string, amounts: number[], code: Code, o: { status?: string; pendingLast?: boolean; inStream?: boolean } = {}) {
  const charges = []
  for (const [i, amount] of amounts.entries()) {
    const last = i === amounts.length - 1
    const plaidTransactionId = `${x.userId}-tx-${++x.n}`
    const t = await prisma.transaction.create({
      data: {
        userId: x.userId, accountId: x.accountId, plaidTransactionId, date: ago(3 + 30 * (amounts.length - 1 - i)),
        amount: amount.toFixed(2), name, cleanName: name, categoryPrimary: code[0], categoryDetailed: code[1],
        pending: last && (o.pendingLast ?? false), isoCurrencyCode: 'USD',
        rawJson: { personal_finance_category: { primary: code[0], detailed: code[1], confidence_level: 'VERY_HIGH' }, counterparties: [] },
      },
    })
    charges.push({ id: t.id, plaidId: plaidTransactionId })
  }
  if (o.inStream !== false) {
    await prisma.recurringStream.create({
      data: {
        userId: x.userId, plaidItemId: x.itemId, streamId: `FAKE-${x.userId}-${++x.n}`, plaidAccountId: `${x.userId}-acct`,
        direction: 'outflow', description: name, merchantName: name, pfcPrimary: code[0], pfcDetailed: code[1],
        frequency: 'MONTHLY', status: o.status ?? 'MATURE', isActive: true, firstDate: ago(90), lastDate: ago(3),
        plaidTransactionIds: charges.map((c) => c.plaidId), plaidUpdatedAt: new Date(),
      },
    })
  }
  return charges
}

const get = (as: string) => request(app).get('/subscriptions').set('X-Test-User', as)
const A_NAMES = ['A STREAMCO', 'A CLINIC', 'A SALON']
const merchantsOf = (body: any) =>
  ['subscriptions', 'bills', 'suggested', 'dismissed', 'upcoming'].flatMap((k) => (body[k] ?? []).map((s: { merchant: string }) => s.merchant))

let aTv: Array<{ id: string; plaidId: string }>
let aDoctor: Array<{ id: string; plaidId: string }>
beforeEach(async () => {
  await wipe(A); await wipe(B)
  w.a = await world(A); w.b = await world(B)
  aTv = await stream(w.a, 'A STREAMCO', [10, 10, 12], TV)            // a subscription, with a price rise
  aDoctor = await stream(w.a, 'A CLINIC', [80, 80, 80], DOCTOR)      // a suggestion
  const aGone = await stream(w.a, 'A SALON', [40, 40, 40], DOCTOR)   // a dismissed suggestion
  await prisma.subscriptionMark.create({ data: { userId: A, transactionId: aGone[2].id, kind: 'dismissed' } })
  await stream(w.b, 'B STREAMCO', [9, 9, 9], TV)
})
afterAll(async () => { await wipe(A); await wipe(B) })

describe('GET /subscriptions reads streams', () => {
  it('returns the composed result: streams, suggestions and dismissals', async () => {
    const { status, body } = await get(A)
    expect(status).toBe(200)
    expect(body.subscriptions.map((s: { merchant: string; source: string }) => [s.merchant, s.source])).toEqual([['A STREAMCO', 'plaid']])
    expect(body.suggested.map((s: { merchant: string }) => s.merchant)).toEqual(['A CLINIC'])
    expect(body.dismissed.map((s: { merchant: string }) => s.merchant)).toEqual(['A SALON'])
    expect(body.totals.monthlySubscriptions).toBe(12)
  })

  it('a monthly series Plaid formed no stream for is not listed: the old detector no longer feeds the tab', async () => {
    await stream(w.a, 'A NOSTREAM', [15, 15, 15], TV, { inStream: false })
    expect(merchantsOf((await get(A)).body)).not.toContain('A NOSTREAM')
  })
})

describe('the bell reads the same composition', () => {
  it('price-up comes from the stream, and every bell subscription is on the tab', async () => {
    const ctx = await loadContext(A)
    if (!ctx.subscriptions.ok) throw ctx.subscriptions.error
    expect('suggested' in ctx.subscriptions.analysis).toBe(true)
    const alerts = await detectSubscriptionPriceUp(ctx)
    expect(alerts.map((a) => a.title)).toEqual(['A STREAMCO raised its price'])
    const tab = merchantsOf((await get(A)).body)
    for (const s of [...ctx.subscriptions.analysis.subscriptions, ...ctx.subscriptions.analysis.bills]) expect(tab).toContain(s.merchant)
  })
})

describe("isolation: nothing of A's reaches B", () => {
  it('GET /subscriptions: none of A\'s streams, suggestions, dismissals or charge ids', async () => {
    const { body } = await get(B)
    expect(merchantsOf(body)).toContain('B STREAMCO') // the control: B sees its own
    const json = JSON.stringify(body)
    for (const name of A_NAMES) expect(json).not.toContain(name)
    for (const c of [...aTv, ...aDoctor]) expect(json).not.toContain(c.id)
  })

  it("the bell: B's input holds none of A's", async () => {
    const ctx = await loadContext(B)
    if (!ctx.subscriptions.ok) throw ctx.subscriptions.error
    const json = JSON.stringify(ctx.subscriptions.analysis)
    expect(json).toContain('B STREAMCO') // the control
    for (const name of A_NAMES) expect(json).not.toContain(name)
  })

  it("membership: A's charge is a 404 for B", async () => {
    const res = await request(app).get(`/subscriptions/marks/membership/${aDoctor[0].id}`).set('X-Test-User', B)
    expect(res.status).toBe(404)
  })

  it("a stream of B's naming A's charges shows nothing of A's", async () => {
    // A charge of A's in no stream of A's, so nothing of A's could fold it away.
    const aLone = await stream(w.a, 'A LONE', [11, 11, 11], TV, { inStream: false })
    await prisma.recurringStream.create({
      data: {
        userId: B, plaidItemId: w.b.itemId, streamId: 'FAKE-b-names-a', plaidAccountId: `${B}-acct`, direction: 'outflow',
        description: 'B ODD', merchantName: 'B ODD', pfcPrimary: TV[0], pfcDetailed: TV[1], frequency: 'MONTHLY', status: 'MATURE',
        isActive: true, firstDate: ago(90), lastDate: ago(3), plaidTransactionIds: aLone.map((c) => c.plaidId), plaidUpdatedAt: new Date(),
      },
    })
    const body = (await get(B)).body
    expect(merchantsOf(body)).not.toContain('B ODD')
    for (const c of aLone) expect(JSON.stringify(body)).not.toContain(c.id)
    // Nor does B's stream reach A, though it names A's charges: streams load by their own user.
    expect(JSON.stringify((await get(A)).body)).not.toContain('B ODD')
  })
})

describe('"Mark as subscription" is a confirmation', () => {
  it('on a suggested stream: membership says where it lands, and the mark anchors on its newest posted charge', async () => {
    const person = await stream(w.a, 'R OKAFOR', [215, 215, 215], PERSON, { pendingLast: true })
    const m = await request(app).get(`/subscriptions/marks/membership/${person[0].id}`).set('X-Test-User', A)
    expect(m.body).toEqual({ state: 'markable', landsIn: 'bill' })
    const res = await request(app).post('/subscriptions/marks').set('X-Test-User', A).send({ transactionId: person[0].id })
    expect(res.status).toBe(201)
    // Not the oldest charge it was opened from, and not the pending newest one.
    expect(res.body.mark.transactionId).toBe(person[1].id)
    const body = (await get(A)).body
    expect(body.bills.map((s: { merchant: string }) => s.merchant)).toContain('R OKAFOR')
    const after = await request(app).get(`/subscriptions/marks/membership/${person[0].id}`).set('X-Test-User', A)
    expect(after.body).toMatchObject({ state: 'marked', landsIn: 'bill' })
  })

  it('replaces a dismissal on the same stream: one answer per stream', async () => {
    const salon = await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: A, kind: 'dismissed' } })
    const salonCharges = await prisma.transaction.findMany({ where: { userId: A, name: 'A SALON' }, orderBy: { date: 'asc' } })
    const res = await request(app).post('/subscriptions/marks').set('X-Test-User', A).send({ transactionId: salonCharges[0].id })
    expect(res.status).toBe(201)
    expect(await prisma.subscriptionMark.findUnique({ where: { id: salon.id } })).toBeNull()
    const onSalon = await prisma.subscriptionMark.findMany({ where: { userId: A, transactionId: { in: salonCharges.map((c) => c.id) } } })
    expect(onSalon.map((v) => v.kind)).toEqual(['confirmed'])
  })
})
