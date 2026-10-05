// ─────────────────────────────────────────────────────────────────
//  "Mark as subscription", end to end on stored data: the series a mark
//  follows, how it merges with detection, what it adds to totals, the
//  price-up alert it feeds, and the API around it.
//
//  Each scenario has its own user, so their merchants can't meet. All
//  names, ids and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { PlaidApi } from 'plaid'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { analyseStoredSubscriptions, fetchSubscriptionAnalysis } from '../src/services/subscriptions.service'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'
import { loadContext } from '../src/services/alerts/dispatcher'

const DAY = 86_400_000
const PREFIX = 'sub-marks-test'
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const ago = (days: number) => new Date(today - days * DAY)

interface TxDef {
  key: string
  ago: number
  amount: number
  name: string
  entity?: string
  pending?: boolean
  primary?: string
  detailed?: string
}

const users: string[] = []
const txId = new Map<string, string>()

async function makeUser(suffix: string, defs: TxDef[]): Promise<string> {
  const userId = `${PREFIX}-${suffix}`
  users.push(userId)
  await prisma.user.create({ data: { id: userId, email: `${userId}@marks-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId, itemId: `${userId}-item`, accessToken: encrypt(`fake-token-${userId}`), institutionName: `${userId}-Bank` },
  })
  const account = await prisma.account.create({
    data: {
      userId, plaidItemId: item.id, plaidAccountId: `${userId}-card`, name: 'Card',
      type: 'credit', subtype: 'credit card', currentBalance: '100.00', isoCurrencyCode: 'USD',
    },
  })
  for (const d of defs) {
    const primary = d.primary ?? 'PERSONAL_CARE'
    const detailed = d.detailed ?? 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'
    const counterparties = d.entity ? [{ name: d.name, type: 'merchant', entity_id: d.entity }] : []
    const t = await prisma.transaction.create({
      data: {
        userId, accountId: account.id, plaidTransactionId: `${userId}-${d.key}`,
        date: ago(d.ago), amount: d.amount.toFixed(2), name: d.name, cleanName: d.name,
        categoryPrimary: primary, categoryDetailed: detailed, pending: d.pending ?? false, isoCurrencyCode: 'USD',
        merchantEntityId: d.entity ?? null,
        counterpartyEntities: d.entity ? [`merchant:${d.entity}`] : [],
        rawJson: {
          personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' },
          merchant_entity_id: d.entity ?? null, counterparties,
        },
      },
    })
    txId.set(`${suffix}/${d.key}`, t.id)
  }
  return userId
}

const mark = (userId: string, suffix: string, key: string) =>
  prisma.subscriptionMark.create({ data: { userId, transactionId: txId.get(`${suffix}/${key}`)! } })

async function cleanup() {
  const where = { userId: { startsWith: PREFIX } }
  await prisma.subscriptionMark.deleteMany({ where })
  await prisma.alert.deleteMany({ where })
  await prisma.transaction.deleteMany({ where })
  await prisma.account.deleteMany({ where })
  await prisma.plaidItem.deleteMany({ where })
  await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } })
}

// ── scenarios ─────────────────────────────────────────────────────

let gymUser = '', bothUser = '', anchorOnlyUser = '', endedUser = '', lookUser = '', apiUser = '', otherUser = ''

beforeAll(async () => {
  await cleanup()

  // A gym under four merchant strings, one entity, a +40% rise last charge,
  // and a one-off purchase from the same gym mid-cycle. Detection can't hold
  // it (names differ; under one identity the one-off and the rise break its
  // cadence and amount tests); the mark is anchored on the first charge.
  gymUser = await makeUser('gym', [
    { key: 'g1', ago: 91, amount: 40, name: 'IRONLINE FITNESS', entity: 'ent-ironline' },
    { key: 'g2', ago: 61, amount: 40, name: 'IRONLINE CLUB 0423', entity: 'ent-ironline' },
    { key: 'one-off', ago: 46, amount: 25, name: 'IRONLINE PRO SHOP', entity: 'ent-ironline' },
    { key: 'g3', ago: 31, amount: 40, name: 'SQ *IRONLINE', entity: 'ent-ironline' },
    { key: 'g4', ago: 1, amount: 56, name: 'IRONLINE FITNESS LLC', entity: 'ent-ironline' },
  ])
  await mark(gymUser, 'gym', 'g1')

  // Detected AND marked: one subscription, not two.
  bothUser = await makeUser('both', [
    { key: 's1', ago: 75, amount: 9.99, name: 'STREAMLET', entity: 'ent-streamlet', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
    { key: 's2', ago: 45, amount: 9.99, name: 'STREAMLET.COM', entity: 'ent-streamlet', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
    { key: 's3', ago: 15, amount: 9.99, name: 'STREAMLET', entity: 'ent-streamlet', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
  ])
  await mark(bothUser, 'both', 's2')

  // Marked on its only charge: schedule unknown.
  anchorOnlyUser = await makeUser('anchor-only', [
    { key: 'a1', ago: 10, amount: 120, name: 'YEARLYCLOUD', entity: 'ent-yearly' },
  ])
  await mark(anchorOnlyUser, 'anchor-only', 'a1')

  // Three monthly charges, then nothing for two slots: ended.
  endedUser = await makeUser('ended', [
    { key: 'e1', ago: 150, amount: 30, name: 'OLDGYM', entity: 'ent-oldgym' },
    { key: 'e2', ago: 120, amount: 30, name: 'OLDGYM', entity: 'ent-oldgym' },
    { key: 'e3', ago: 90, amount: 45, name: 'OLDGYM', entity: 'ent-oldgym' },
  ])
  await mark(endedUser, 'ended', 'e1')

  // Look-alike names of one merchant, unmarked: detection by identity finds it.
  lookUser = await makeUser('look', [
    { key: 'l1', ago: 70, amount: 15, name: 'LOOKALIKE ONE', entity: 'ent-look', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO' },
    { key: 'l2', ago: 40, amount: 15, name: 'LOOKALIKE-TWO X', entity: 'ent-look', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO' },
    { key: 'l3', ago: 10, amount: 15, name: 'LKLK THREE', entity: 'ent-look', primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO' },
  ])

  // The API's user, and another whose rows they must never touch.
  apiUser = await makeUser('api', [
    { key: 'p1', ago: 65, amount: 12, name: 'PODLY', entity: 'ent-podly' },
    { key: 'p2', ago: 35, amount: 12, name: 'PODLY', entity: 'ent-podly' },
    { key: 'pending', ago: 0, amount: 30, name: 'NEWSHOP', entity: 'ent-newshop', pending: true },
    { key: 'pay', ago: 3, amount: -900, name: 'PAYROLL', primary: 'INCOME', detailed: 'INCOME_SALARY' },
  ])
  otherUser = await makeUser('other', [
    { key: 'o1', ago: 20, amount: 18, name: 'OTHERS GYM', entity: 'ent-others' },
  ])
})

afterAll(cleanup)

describe('a marked subscription', () => {
  it('follows the merchant across names and to its new price, and leaves the one-off out', async () => {
    const a = await analyseStoredSubscriptions(gymUser)
    expect(a.subscriptions).toHaveLength(1)
    const s = a.subscriptions[0]
    expect(s.key).toBe('entity:ent-ironline')
    expect(s.mark).not.toBeNull()
    expect(s.frequency).toBe('MONTHLY')
    expect(s.status).toBe('active')
    expect([...s.txIds].sort()).toEqual(['g1', 'g2', 'g3', 'g4'].map((k) => txId.get(`gym/${k}`)!).sort())
    expect(s.lastAmount).toBe(56)
    expect(s.priceChange).toEqual({ previousAmount: 40, pctChange: 40 })
  })

  it('feeds price-up: the bell gets the rise', async () => {
    const alerts = await detectSubscriptionPriceUp(await loadContext(gymUser))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].fingerprint).toBe(`price_up:entity:ent-ironline:${ago(1).toISOString().slice(0, 10)}`)
  })

  it('and a detected subscription of the same merchant are one subscription', async () => {
    const a = await analyseStoredSubscriptions(bothUser)
    const all = [...a.subscriptions, ...a.bills]
    expect(all).toHaveLength(1)
    expect(all[0].mark).not.toBeNull()
  })

  it('with only its anchor adds nothing to monthly totals', async () => {
    const a = await analyseStoredSubscriptions(anchorOnlyUser)
    expect(a.subscriptions).toHaveLength(1)
    expect(a.subscriptions[0].frequency).toBe('UNKNOWN')
    expect(a.subscriptions[0].monthlyAmount).toBe(0)
    expect(a.totals).toEqual({ monthlySubscriptions: 0, monthlyBills: 0, monthlyAll: 0 })
    expect(a.upcoming).toHaveLength(0)
  })

  it('that has ended is shown as ended, out of the totals, with no price-up', async () => {
    const a = await analyseStoredSubscriptions(endedUser)
    expect(a.subscriptions).toHaveLength(1)
    expect(a.subscriptions[0].status).toBe('ended')
    expect(a.totals.monthlyAll).toBe(0)
    expect(a.upcoming).toHaveLength(0)
    expect(await detectSubscriptionPriceUp(await loadContext(endedUser))).toHaveLength(0)
  })

  it('stays in the tab whenever it is in the bell', async () => {
    for (const userId of [gymUser, bothUser, anchorOnlyUser, endedUser, lookUser]) {
      const bell = await analyseStoredSubscriptions(userId)
      const tab = await fetchSubscriptionAnalysis(userId, new PlaidApi() as PlaidApi)
      const tabKeys = new Set([...tab.subscriptions, ...tab.bills].map((s) => `${s.key}|${s.mark?.id ?? ''}`))
      for (const s of [...bell.subscriptions, ...bell.bills]) expect(tabKeys.has(`${s.key}|${s.mark?.id ?? ''}`), userId).toBe(true)
    }
  })
})

describe('detection', () => {
  it("groups by merchant identity, so one merchant's look-alike names are one subscription", async () => {
    const a = await analyseStoredSubscriptions(lookUser)
    const all = [...a.subscriptions, ...a.bills]
    expect(all.map((s) => s.key)).toEqual(['entity:ent-look'])
    expect(all[0].mark).toBeNull()
  })
})

// ── the API ───────────────────────────────────────────────────────

const as = (userId: string) => ({
  post: (body: object) => request(app).post('/subscriptions/marks').set('X-Test-User', userId).send(body),
  del: (id: string) => request(app).delete(`/subscriptions/marks/${id}`).set('X-Test-User', userId),
  membership: (transactionId: string) =>
    request(app).get(`/subscriptions/marks/membership/${transactionId}`).set('X-Test-User', userId),
})

describe('POST /subscriptions/marks', () => {
  it("refuses another user's transaction with 404, and writes nothing", async () => {
    const theirs = txId.get('other/o1')!
    const before = await prisma.subscriptionMark.count()
    const res = await as(apiUser).post({ transactionId: theirs })
    expect(res.status).toBe(404)
    expect(await prisma.subscriptionMark.count()).toBe(before)
    expect(await prisma.subscriptionMark.count({ where: { transactionId: theirs } })).toBe(0)
  })

  it('refuses a pending row and a row that is not spending, with 409', async () => {
    for (const key of ['pending', 'pay']) {
      const res = await as(apiUser).post({ transactionId: txId.get(`api/${key}`)! })
      expect(res.status, key).toBe(409)
    }
    expect(await prisma.subscriptionMark.count({ where: { userId: apiUser } })).toBe(0)
  })

  it('refuses a missing or malformed transactionId with 400', async () => {
    expect((await as(apiUser).post({})).status).toBe(400)
    expect((await as(apiUser).post({ transactionId: 7 })).status).toBe(400)
  })

  it('creates a mark, and marking another charge of the same series returns that mark', async () => {
    const first = await as(apiUser).post({ transactionId: txId.get('api/p1')! })
    expect(first.status).toBe(201)
    const again = await as(apiUser).post({ transactionId: txId.get('api/p2')! })
    expect(again.status).toBe(200)
    expect(again.body.mark.id).toBe(first.body.mark.id)
    expect(await prisma.subscriptionMark.count({ where: { userId: apiUser } })).toBe(1)
  })

  it('reports membership for the panel', async () => {
    const markId = (await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: apiUser } })).id
    expect((await as(apiUser).membership(txId.get('api/p2')!)).body).toEqual({ state: 'marked', markId })
    expect((await as(apiUser).membership(txId.get('api/pending')!)).body).toMatchObject({ state: 'unavailable' })
    expect((await as(apiUser).membership(txId.get('api/pay')!)).body).toMatchObject({ state: 'unavailable' })
    expect((await as(bothUser).membership(txId.get('both/s1')!)).body).toMatchObject({ state: 'marked' })
    expect((await as(lookUser).membership(txId.get('look/l1')!)).body).toEqual({ state: 'detected' })
    expect((await as(otherUser).membership(txId.get('other/o1')!)).body).toEqual({ state: 'markable' })
    expect((await as(apiUser).membership(txId.get('other/o1')!)).status).toBe(404)
  })
})

describe('DELETE /subscriptions/marks/:id', () => {
  it("refuses another user's mark with 404, and leaves it", async () => {
    const theirs = await mark(otherUser, 'other', 'o1')
    const res = await as(apiUser).del(theirs.id)
    expect(res.status).toBe(404)
    expect(await prisma.subscriptionMark.findUnique({ where: { id: theirs.id } })).toEqual(theirs)
    await prisma.subscriptionMark.delete({ where: { id: theirs.id } })
  })

  it('un-marks: removes the mark and nothing else', async () => {
    const m = await prisma.subscriptionMark.findFirstOrThrow({ where: { userId: apiUser } })
    const txBefore = await prisma.transaction.count({ where: { userId: apiUser } })
    const res = await as(apiUser).del(m.id)
    expect(res.status).toBe(200)
    expect(await prisma.subscriptionMark.count({ where: { userId: apiUser } })).toBe(0)
    expect(await prisma.transaction.count({ where: { userId: apiUser } })).toBe(txBefore)
    expect((await as(apiUser).del(m.id)).status).toBe(404)
  })
})

describe('the database', () => {
  it("refuses a mark whose user is not its transaction's user", async () => {
    await expect(
      prisma.subscriptionMark.create({ data: { userId: apiUser, transactionId: txId.get('other/o1')! } }),
    ).rejects.toThrow()
    expect(await prisma.subscriptionMark.count({ where: { transactionId: txId.get('other/o1')! } })).toBe(0)
  })
})
