// ─────────────────────────────────────────────────────────────────
//  tests/isolation.test.ts — M6.1 cross-tenant data isolation suite
//
//  Exercises the REAL app (src/app.ts) in-process via supertest, with
//  ONLY Clerk's token verification and the Plaid SDK's network calls
//  stubbed (see tests/setup.ts). Every route, controller, service,
//  and Prisma query under test is the actual, unmodified app code.
//
//  Requests "authenticate" as a given fixture user via the
//  `X-Test-User` header (read by the mocked getAuth()), or as the
//  demo user via the real `X-Demo-Mode: 1` header.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER_A = 'isolation-test-user-a'
const USER_B = 'isolation-test-user-b'
const DEMO_USER_ID = 'demo-user'

interface ExtraFixture {
  budgetId: string
  goalId: string
  alertId: string
  snapshotId: string
}

interface UserFixture {
  userId: string
  accountId: string
  plaidItemId: string
  transactionIds: string[]
  /** Strings that must NEVER appear in another user's (or demo's) response body. */
  markers: string[]
  extra?: ExtraFixture
}

// ── Fixture helpers ──────────────────────────────────────────────

async function seedUser(userId: string, withExtras: boolean): Promise<UserFixture> {
  await prisma.user.create({ data: { id: userId, email: `${userId}@isolation-test.local` } })

  const plaidItem = await prisma.plaidItem.create({
    data: {
      userId,
      itemId: `${userId}-item-1`,
      accessToken: encrypt(`fake-access-token-${userId}`),
      institutionId: `ins_${userId}`,
      institutionName: `${userId}-Test-Bank`,
    },
  })

  const account = await prisma.account.create({
    data: {
      userId,
      plaidItemId: plaidItem.id,
      plaidAccountId: `${userId}-acct-1`,
      name: `${userId}-Checking-Marker`,
      type: 'depository',
      subtype: 'checking',
      currentBalance: userId === USER_A ? '11111.11' : '22222.22',
      availableBalance: userId === USER_A ? '11111.11' : '22222.22',
      isoCurrencyCode: 'USD',
    },
  })

  const now = new Date()
  const txDefs = [
    { name: `${userId}-MERCHANT-GROCERY`, amount: '61.23', category: 'GROCERIES', daysAgo: 2 },
    { name: `${userId}-MERCHANT-DINING`, amount: '18.45', category: 'FOOD_AND_DRINK', daysAgo: 5 },
    { name: `${userId}-MERCHANT-INCOME`, amount: '-2450.00', category: 'INCOME', daysAgo: 10 },
    { name: `${userId}-MERCHANT-SHOP`, amount: '87.60', category: 'GENERAL_MERCHANDISE', daysAgo: 20 },
  ]

  const transactionIds: string[] = []
  for (const [i, def] of txDefs.entries()) {
    const tx = await prisma.transaction.create({
      data: {
        userId,
        accountId: account.id,
        plaidTransactionId: `${userId}-tx-${i + 1}`,
        date: new Date(now.getTime() - def.daysAgo * 86400000),
        amount: def.amount,
        name: def.name,
        cleanName: def.name,
        merchantName: def.name,
        categoryPrimary: def.category,
        categoryDetailed: def.category,
        isoCurrencyCode: 'USD',
        pending: false,
        tags: [`${userId}-tag`],
        notes: `${userId}-note-marker`,
      },
    })
    transactionIds.push(tx.id)
  }

  const markers = [
    account.id,
    account.plaidAccountId,
    account.name,
    plaidItem.id,
    plaidItem.itemId,
    plaidItem.institutionName!,
    ...transactionIds,
    ...txDefs.map((d) => d.name),
  ]

  const fixture: UserFixture = {
    userId,
    accountId: account.id,
    plaidItemId: plaidItem.id,
    transactionIds,
    markers,
  }

  if (withExtras) {
    const budget = await prisma.budget.create({
      data: { userId, category: 'GROCERIES', monthlyLimit: '555.55' },
    })
    const goal = await prisma.goal.create({
      data: {
        userId,
        type: 'savings',
        name: `${userId}-Goal-Marker`,
        targetAmount: '9999.00',
        startAmount: '100.00',
      },
    })
    const alert = await prisma.alert.create({
      data: {
        userId,
        kind: 'large_transaction',
        fingerprint: `${userId}-fingerprint-1`,
        severity: 'warning',
        title: `${userId}-Alert-Marker`,
        body: `${userId}-alert-body-marker`,
      },
    })
    const snapshot = await prisma.balanceSnapshot.create({
      data: {
        userId,
        accountId: account.plaidAccountId,
        accountName: account.name,
        accountType: 'depository',
        currentBalance: '11111.11',
        availableBalance: '11111.11',
        isoCurrencyCode: 'USD',
        date: now,
      },
    })

    fixture.extra = { budgetId: budget.id, goalId: goal.id, alertId: alert.id, snapshotId: snapshot.id }
    fixture.markers.push(
      budget.id,
      goal.id,
      goal.name,
      alert.id,
      alert.title,
      alert.body,
      snapshot.id,
      snapshot.accountName,
    )
  }

  return fixture
}

async function cleanupUser(userId: string): Promise<void> {
  // FK-safe order (mirrors prisma/seed-demo.ts): Transaction -> Account ->
  // PlaidItem -> User, plus the independent (no-FK) models.
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.account.deleteMany({ where: { userId } })
  await prisma.plaidItem.deleteMany({ where: { userId } })
  await prisma.budget.deleteMany({ where: { userId } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId } })
  await prisma.alert.deleteMany({ where: { userId } })
  await prisma.goal.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
}

function bodyText(res: request.Response): string {
  return `${JSON.stringify(res.body ?? {})}\n${res.text ?? ''}`
}

/** Asserts none of `markers` appear anywhere in the HTTP response body. */
function assertNoLeak(res: request.Response, markers: string[], label: string): void {
  const text = bodyText(res)
  for (const marker of markers) {
    expect(text.includes(marker), `${label} — response leaked marker "${marker}"`).toBe(false)
  }
}

const READ_ENDPOINTS = [
  '/accounts',
  '/transactions',
  '/budgets',
  '/alerts',
  '/alerts/all',
  '/goals',
  '/networth',
  '/insights',
  '/score',
  '/cashflow',
  '/subscriptions',
  '/recurring',
  '/transactions/search',
  '/transactions/trends',
  '/transactions/categories',
  '/budgets/status',
  '/alerts/digest',
]

// ── Fixtures ──────────────────────────────────────────────────────

let userA: UserFixture
let userB: UserFixture

beforeAll(async () => {
  // Clean slate — in case a previous run crashed mid-suite.
  await cleanupUser(USER_A)
  await cleanupUser(USER_B)
  userA = await seedUser(USER_A, true)
  userB = await seedUser(USER_B, false)
})

afterAll(async () => {
  await cleanupUser(USER_A)
  await cleanupUser(USER_B)
  await prisma.$disconnect()
})

// ── A. Read isolation ─────────────────────────────────────────────

describe('A. Read isolation — user-b must never see user-a data', () => {
  it.each(READ_ENDPOINTS)('GET %s does not leak user-a records to user-b', async (path) => {
    const res = await request(app).get(path).set('X-Test-User', USER_B)
    assertNoLeak(res, userA.markers, `GET ${path} (as user-b)`)
  })
})

// ── B. IDOR re-test ────────────────────────────────────────────────

describe('B. IDOR re-test — user-b cannot mutate user-a rows by id', () => {
  it('PATCH /transactions/:id (user-a tx) as user-b -> 404, row unchanged', async () => {
    const txId = userA.transactionIds[0]
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })

    const res = await request(app)
      .patch(`/transactions/${txId}`)
      .set('X-Test-User', USER_B)
      .send({ notes: 'HACKED-BY-USER-B', tags: ['pwned'], category: 'ENTERTAINMENT' })

    expect(res.status).toBe(404)

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('DELETE /budgets/:id (user-a budget) as user-b -> no-op, row unchanged', async () => {
    const budgetId = userA.extra!.budgetId
    const before = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } })

    const res = await request(app).delete(`/budgets/${budgetId}`).set('X-Test-User', USER_B)

    // budgets.service.ts's deleteBudget does deleteMany({ id, userId }) — a
    // foreign id matches 0 rows and returns { ok: true } rather than 404.
    // The spec allows "fail or no-op"; assert the no-op and prove the row survives.
    expect(res.status).toBe(200)

    const after = await prisma.budget.findUnique({ where: { id: budgetId } })
    expect(after).not.toBeNull()
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('PATCH /goals/:id (user-a goal) as user-b -> 404, row unchanged', async () => {
    const goalId = userA.extra!.goalId
    const before = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } })

    const res = await request(app)
      .patch(`/goals/${goalId}`)
      .set('X-Test-User', USER_B)
      .send({ name: 'HACKED-BY-USER-B', targetAmount: 1 })

    expect(res.status).toBe(404)

    const after = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('DELETE /goals/:id (user-a goal) as user-b -> 404, row unchanged (not soft-deleted)', async () => {
    const goalId = userA.extra!.goalId
    const before = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } })

    const res = await request(app).delete(`/goals/${goalId}`).set('X-Test-User', USER_B)

    expect(res.status).toBe(404)

    const after = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } })
    expect(after.deletedAt).toBeNull()
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('POST /alerts/:id/dismiss (user-a alert) as user-b -> 404, row unchanged', async () => {
    const alertId = userA.extra!.alertId
    const before = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })

    const res = await request(app).post(`/alerts/${alertId}/dismiss`).set('X-Test-User', USER_B)

    expect(res.status).toBe(404)

    const after = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })
    expect(after.dismissedAt).toBeNull()
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })
})

// ── C. Demo path ───────────────────────────────────────────────────

describe('C. Demo mode — read-only, resolves to the demo user only', () => {
  it.each(READ_ENDPOINTS)('GET %s (demo mode) does not leak user-a/user-b records', async (path) => {
    const res = await request(app).get(path).set('X-Demo-Mode', '1')
    assertNoLeak(res, [...userA.markers, ...userB.markers], `GET ${path} (demo)`)
  })

  it('POST /budgets is blocked in demo mode with no DB change', async () => {
    const before = await prisma.budget.count({ where: { userId: DEMO_USER_ID } })

    const res = await request(app)
      .post('/budgets')
      .set('X-Demo-Mode', '1')
      .send({ category: 'GROCERIES', monthlyLimit: 1 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.budget.count({ where: { userId: DEMO_USER_ID } })
    expect(after).toBe(before)
  })

  it('PATCH /transactions/:id is blocked in demo mode with no DB change', async () => {
    const txId = userA.transactionIds[0]
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })

    const res = await request(app)
      .patch(`/transactions/${txId}`)
      .set('X-Demo-Mode', '1')
      .send({ notes: 'demo-hack' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('POST /goals is blocked in demo mode with no DB change', async () => {
    const before = await prisma.goal.count({ where: { userId: DEMO_USER_ID } })

    const res = await request(app)
      .post('/goals')
      .set('X-Demo-Mode', '1')
      .send({ type: 'savings', name: 'demo-hack-goal', targetAmount: 1 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.goal.count({ where: { userId: DEMO_USER_ID } })
    expect(after).toBe(before)
  })

  it('POST /alerts/:id/dismiss is blocked in demo mode with no DB change', async () => {
    const alertId = userA.extra!.alertId
    const before = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })

    const res = await request(app).post(`/alerts/${alertId}/dismiss`).set('X-Demo-Mode', '1')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('X-Demo-Mode + X-Test-User=user-a on a READ still resolves to demo, not user-a', async () => {
    // getUserId() checks isDemoRequest() FIRST and returns DEMO_USER_ID
    // unconditionally — X-Test-User must never escalate demo into a real session.
    const res = await request(app).get('/accounts').set('X-Demo-Mode', '1').set('X-Test-User', USER_A)
    assertNoLeak(res, userA.markers, 'GET /accounts (demo + X-Test-User=user-a)')
  })

  it('X-Demo-Mode + X-Test-User=user-a on a WRITE still blocks the write (demo wins)', async () => {
    const before = await prisma.budget.count({ where: { userId: USER_A } })

    const res = await request(app)
      .post('/budgets')
      .set('X-Demo-Mode', '1')
      .set('X-Test-User', USER_A)
      .send({ category: 'GROCERIES', monthlyLimit: 1 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.budget.count({ where: { userId: USER_A } })
    expect(after).toBe(before)
  })
})

// ── D. Unauthenticated ───────────────────────────────────────────────

describe('D. Unauthenticated — no headers means no data', () => {
  it.each(READ_ENDPOINTS)('GET %s with no auth headers returns no data', async (path) => {
    const res = await request(app).get(path)
    expect(res.status, `GET ${path} unexpectedly returned 200 with no auth`).not.toBe(200)
    assertNoLeak(res, [...userA.markers, ...userB.markers], `GET ${path} (unauthenticated)`)
  })
})
