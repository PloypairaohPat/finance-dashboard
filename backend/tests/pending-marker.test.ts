// ─────────────────────────────────────────────────────────────────
//  Pending rows count in every figure, so wherever one is shown it says so;
//  and the two event alerts (large purchase, price-up) wait for the charge to
//  post, because the posted row has a new id and possibly a new date and
//  amount: alerting on the pending one meant alerting twice.
//  All names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { loadContext } from '../src/services/alerts/dispatcher'
import { detectLargeTransaction } from '../src/services/alerts/detectors/largeTransaction'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'
import { analyseStoredSubscriptions } from '../src/services/subscriptions.service'

const USER = 'pending-marker-test-user'
const DAY = 86_400_000
const now = new Date()
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
// Inside the current calendar money period (start day 1), so /insights sees them.
const thisPeriod = (back: number) => new Date(Math.max(today - back * DAY, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
const ids: Record<string, string> = {}

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

async function add(key: string, date: Date, amount: number, name: string, pending: boolean, primary = 'GENERAL_MERCHANDISE', detailed = 'GENERAL_MERCHANDISE_ELECTRONICS') {
  const account = await prisma.account.findFirstOrThrow({ where: { userId: USER } })
  const t = await prisma.transaction.create({
    data: {
      userId: USER, accountId: account.id, plaidTransactionId: `${USER}-${key}`, date,
      amount: amount.toFixed(2), name, cleanName: name, categoryPrimary: primary, categoryDetailed: detailed,
      pending, isoCurrencyCode: 'USD', merchantEntityId: null, counterpartyEntities: [],
      rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' }, counterparties: [] },
    },
  })
  ids[key] = t.id
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@pending-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: `${USER}-Bank` },
  })
  await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-card`, name: 'Card', type: 'credit', isoCurrencyCode: 'USD' },
  })
  // A large purchase, still pending.
  await add('big-pending', thisPeriod(0), 649.99, 'GADGETHAUS', true)
  // A smaller settled one at a merchant that also has a pending charge.
  await add('cafe-posted', thisPeriod(1), 12, 'CORNER CAFE', false, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE')
  await add('cafe-pending', thisPeriod(0), 9, 'CORNER CAFE', true, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE')
  // A subscription whose raised charge is still pending.
  for (const [k, back, amt, pend] of [['s1', 80, 10, false], ['s2', 55, 10, false], ['s3', 30, 10, false], ['s4', 5, 12, true]] as const) {
    await add(k, new Date(today - back * DAY), amt, 'STREAMLET', pend, 'ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES')
  }
})

afterAll(cleanup)

describe('the marker reaches every place a pending row is shown', () => {
  it('Largest purchases says which items are pending; Top merchants how many pending rows it includes', async () => {
    const { body } = await request(app).get('/insights').set('X-Test-User', USER)
    const big = body.largestPurchases.find((p: { id: string }) => p.id === ids['big-pending'])
    expect(big).toMatchObject({ pending: true })
    const cafePosted = body.largestPurchases.find((p: { id: string }) => p.id === ids['cafe-posted'])
    expect(cafePosted).toMatchObject({ pending: false })
    const cafe = body.topMerchants.find((m: { merchant: string }) => m.merchant === 'CORNER CAFE')
    expect(cafe).toMatchObject({ count: 2, pendingCount: 1 })
  })

  it('a subscription whose last charge is pending says so', async () => {
    const a = await analyseStoredSubscriptions(USER)
    const s = [...a.subscriptions, ...a.bills].find((x) => x.key === 'streamlet')
    expect(s).toMatchObject({ lastChargePending: true, lastAmount: 12 })
  })
})

describe('event alerts wait for the charge to post', () => {
  it('no large-purchase alert on a pending row', async () => {
    const alerts = await detectLargeTransaction(await loadContext(USER))
    expect(alerts.map((a) => a.data?.transactionId)).not.toContain(ids['big-pending'])
  })

  it('no price-up while the raised charge is pending', async () => {
    expect(await detectSubscriptionPriceUp(await loadContext(USER))).toHaveLength(0)
  })

  it('both fire once the charges post', async () => {
    await prisma.transaction.updateMany({ where: { id: { in: [ids['big-pending'], ids['s4']] } }, data: { pending: false } })
    const ctx = await loadContext(USER)
    expect((await detectLargeTransaction(ctx)).map((a) => a.data?.transactionId)).toContain(ids['big-pending'])
    expect(await detectSubscriptionPriceUp(ctx)).toHaveLength(1)
    await prisma.transaction.updateMany({ where: { id: { in: [ids['big-pending'], ids['s4']] } }, data: { pending: true } })
  })
})
