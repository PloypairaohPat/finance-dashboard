// ─────────────────────────────────────────────────────────────────
//  tests/user-settings.test.ts — M7.2 period start day, end to end
//
//  GET/PUT /user/settings validation and isolation, demo refusal, and proof
//  that the STORED start day is what the period-grouped endpoints use: two
//  transactions either side of a day-10 boundary land in different periods at
//  start day 10, and in the calendar months toISOString().slice(0, 7) gives at
//  start day 1.
//
//  Also (Q2): periods before a user's first transaction are dropped, while
//  empty periods after it stay as zeros.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { fromDateKey, recentPeriods } from '../src/lib/period'

const USER = 'period-settings-test-user'
const OTHER = 'period-settings-test-other'
const NO_ROW = 'period-settings-test-no-row'
const GAP = 'period-settings-test-gap'
const DEMO_USER_ID = 'demo-user'
const DAY_MS = 86_400_000

let demoRowCreatedHere = false
let beforeBoundary: Date
let onBoundary: Date
let gapPeriodKeys: string[]

async function cleanup(userId: string): Promise<void> {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.account.deleteMany({ where: { userId } })
  await prisma.plaidItem.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
}

async function seed(userId: string): Promise<string> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@period-test.local` } })
  const item = await prisma.plaidItem.create({
    data: {
      userId,
      itemId: `${userId}-item`,
      accessToken: encrypt(`fake-access-token-${userId}`),
      institutionName: `${userId}-Bank`,
    },
  })
  const account = await prisma.account.create({
    data: {
      userId,
      plaidItemId: item.id,
      plaidAccountId: `${userId}-acct`,
      name: `${userId}-Checking`,
      type: 'depository',
      subtype: 'checking',
      currentBalance: '5000.00',
      isoCurrencyCode: 'USD',
    },
  })
  return account.id
}

async function addTransactions(userId: string, accountId: string, txs: Array<{ at: Date; amount: string }>) {
  await prisma.transaction.createMany({
    data: txs.map(({ at, amount }, i) => ({
      userId,
      accountId,
      plaidTransactionId: `${userId}-tx-${i + 1}`,
      date: at,
      amount,
      name: `${userId}-MERCHANT-${i + 1}`,
      categoryPrimary: 'GENERAL_MERCHANDISE',
      isoCurrencyCode: 'USD',
      pending: false,
    })),
  })
}

const put = (userId: string, body: unknown) =>
  request(app).put('/user/settings').set('X-Test-User', userId).send(body as object)

beforeAll(async () => {
  for (const u of [USER, OTHER, NO_ROW, GAP]) await cleanup(u)
  const accountId = await seed(USER)
  await prisma.user.create({ data: { id: OTHER, email: `${OTHER}@period-test.local` } })

  if (!(await prisma.user.findUnique({ where: { id: DEMO_USER_ID } }))) {
    await prisma.user.create({ data: { id: DEMO_USER_ID, email: 'demo@period-test.local' } })
    demoRowCreatedHere = true
  }

  // The current day-10 period's first day, and the day before it (the previous
  // period's last day). Both are in the past, so both are inside the windows.
  const [, current] = recentPeriods(new Date(), 10, 2)
  onBoundary = fromDateKey(current.start)
  beforeBoundary = new Date(onBoundary.getTime() - DAY_MS)

  await addTransactions(USER, accountId, [
    { at: beforeBoundary, amount: '100.00' },
    { at: onBoundary, amount: '40.00' },
  ])

  // GAP user, at start day 1: first transaction four periods ago, then nothing
  // until the current period. Two periods before it must be dropped; the
  // three empty periods between must stay.
  const gapAccountId = await seed(GAP)
  const six = recentPeriods(new Date(), 1, 6)
  gapPeriodKeys = six.map((p) => p.key)
  await addTransactions(GAP, gapAccountId, [
    { at: fromDateKey(six[2].start), amount: '75.00' },
    { at: fromDateKey(six[5].start), amount: '25.00' },
  ])
})

afterAll(async () => {
  for (const u of [USER, OTHER, NO_ROW, GAP]) await cleanup(u)
  if (demoRowCreatedHere) await prisma.user.deleteMany({ where: { id: DEMO_USER_ID } })
})

describe('GET/PUT /user/settings', () => {
  it('a signed-in user with no User row gets the default, calendar months', async () => {
    const res = await request(app).get('/user/settings').set('X-Test-User', NO_ROW)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ periodStartDay: 1 })
  })

  it.each([[0], [29], [1.5], ['10'], [null], [undefined]])(
    'rejects periodStartDay=%j with 400 and changes nothing',
    async (value) => {
      const res = await put(USER, { periodStartDay: value })
      expect(res.status).toBe(400)
      const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } })
      expect(row.periodStartDay).toBe(1)
    },
  )

  it('saves a valid day and returns it', async () => {
    const res = await put(USER, { periodStartDay: 10 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ periodStartDay: 10 })
    const read = await request(app).get('/user/settings').set('X-Test-User', USER)
    expect(read.body).toEqual({ periodStartDay: 10 })
  })

  it('creates the User row for a first-time user (ensureUser)', async () => {
    const res = await put(NO_ROW, { periodStartDay: 28 })
    expect(res.status).toBe(200)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: NO_ROW } })
    expect(row.periodStartDay).toBe(28)
  })

  it("one user's setting never reads or writes another's", async () => {
    await put(USER, { periodStartDay: 10 })
    const otherRead = await request(app).get('/user/settings').set('X-Test-User', OTHER)
    expect(otherRead.body).toEqual({ periodStartDay: 1 })
    await put(OTHER, { periodStartDay: 20 })
    const userRow = await prisma.user.findUniqueOrThrow({ where: { id: USER } })
    expect(userRow.periodStartDay).toBe(10)
  })

  it('is refused in demo mode with the read-only response and no DB change', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } })
    const res = await request(app).put('/user/settings').set('X-Demo-Mode', '1').send({ periodStartDay: 15 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })
    const after = await prisma.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } })
    expect(after.periodStartDay).toBe(before.periodStartDay)
  })
})

describe('period-grouped endpoints use the stored start day', () => {
  it('at start day 10, transactions either side of the 10th land in different periods', async () => {
    await put(USER, { periodStartDay: 10 })
    const res = await request(app).get('/cashflow').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    const periods = res.body.cashflow as Array<{ key: string; expenses: number; txCount: number; inProgress: boolean }>
    // The user's first transaction is in the previous period, so the four
    // periods before it are dropped (Q2).
    expect(periods).toHaveLength(2)

    const [previous, current] = periods
    expect(current.key).toBe(onBoundary.toISOString().slice(0, 10))
    expect(current).toMatchObject({ expenses: 40, txCount: 1, inProgress: true })
    expect(previous).toMatchObject({ expenses: 100, txCount: 1, inProgress: false })
  })

  it('at start day 1, the same transactions group exactly by calendar month', async () => {
    await put(USER, { periodStartDay: 1 })
    const res = await request(app).get('/cashflow').set('X-Test-User', USER)
    const periods = res.body.cashflow as Array<{ key: string; expenses: number }>

    const expected = new Map<string, number>()
    for (const [at, amount] of [[beforeBoundary, 100], [onBoundary, 40]] as const) {
      const legacyKey = `${at.toISOString().slice(0, 7)}-01`
      expected.set(legacyKey, (expected.get(legacyKey) ?? 0) + amount)
    }
    for (const [key, total] of expected) {
      expect(periods.find((p) => p.key === key)?.expenses, key).toBe(total)
    }
  })

  it('trends, comparison, insights, categories and net worth all report periods', async () => {
    await put(USER, { periodStartDay: 10 })
    const trends = await request(app).get('/transactions/trends').set('X-Test-User', USER)
    // 12 requested; only the two from the first transaction on remain (Q2).
    expect(trends.body.trends).toHaveLength(2)
    expect(trends.body.trends.at(-1)).toMatchObject({ inProgress: true, total: 40 })

    const comparison = await request(app).get('/categories/comparison').set('X-Test-User', USER)
    expect(comparison.body).toHaveLength(2)
    expect(comparison.body.at(-1)).toMatchObject({ key: onBoundary.toISOString().slice(0, 10), inProgress: true })

    const insights = await request(app).get('/insights').set('X-Test-User', USER)
    expect(insights.body.summary.period).toMatchObject({ key: onBoundary.toISOString().slice(0, 10), inProgress: true })

    // Spending breakdown follows the period too: only the $40 on the boundary
    // day is in the current day-10 period, not the $100 the day before.
    const categories = await request(app).get('/categories').set('X-Test-User', USER)
    expect(categories.body.period).toMatchObject({ key: onBoundary.toISOString().slice(0, 10), inProgress: true })
    expect(categories.body.categories).toEqual([expect.objectContaining({ category: 'Shopping', amount: 40 })])

    const networth = await request(app).get('/networth').set('X-Test-User', USER)
    expect(Array.isArray(networth.body.periodMarkers)).toBe(true)
  })
})

describe('periods before the first transaction are dropped; interior gaps stay (Q2)', () => {
  it('cash flow starts at the first transaction and keeps the empty periods after it', async () => {
    const res = await request(app).get('/cashflow').set('X-Test-User', GAP)
    const periods = res.body.cashflow as Array<{ key: string; expenses: number; txCount: number }>
    expect(periods.map((p) => p.key)).toEqual(gapPeriodKeys.slice(2))
    expect(periods.map((p) => p.expenses)).toEqual([75, 0, 0, 25])
    expect(periods.map((p) => p.txCount)).toEqual([1, 0, 0, 1])
  })

  it('trends drop the same pre-history periods and keep the same interior zeros', async () => {
    const res = await request(app).get('/transactions/trends?months=6').set('X-Test-User', GAP)
    const trends = res.body.trends as Array<{ key: string; total: number }>
    expect(trends.map((t) => t.key)).toEqual(gapPeriodKeys.slice(2))
    expect(trends.map((t) => t.total)).toEqual([75, 0, 0, 25])
  })

  it('a user with no transactions gets no periods, not six zero bars', async () => {
    const res = await request(app).get('/cashflow').set('X-Test-User', OTHER)
    expect(res.body.cashflow).toEqual([])
  })
})
