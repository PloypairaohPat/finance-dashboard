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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app, plaidClient } from '../src/app'
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
  '/plaid-items',
]

// ── Fixtures ──────────────────────────────────────────────────────

let userA: UserFixture
let userB: UserFixture
let demoItem: { id: string; institutionName: string }

beforeAll(async () => {
  // Clean slate — in case a previous run crashed mid-suite.
  await cleanupUser(USER_A)
  await cleanupUser(USER_B)
  await cleanupUser(DEMO_USER_ID)
  userA = await seedUser(USER_A, true)
  userB = await seedUser(USER_B, false)

  // M6.7 — a demo PlaidItem, mirroring prisma/seed-demo.ts's shape, so the
  // demo-mode /plaid-items tests have something concrete to assert against.
  await prisma.user.create({ data: { id: DEMO_USER_ID, email: 'demo@isolation-test.local' } })
  const createdDemoItem = await prisma.plaidItem.create({
    data: {
      userId: DEMO_USER_ID,
      itemId: 'demo-item-1',
      accessToken: 'DEMO-NO-TOKEN',
      institutionId: 'ins_demo',
      institutionName: 'Demo Bank',
    },
  })
  demoItem = { id: createdDemoItem.id, institutionName: createdDemoItem.institutionName! }
})

afterAll(async () => {
  await cleanupUser(USER_A)
  await cleanupUser(USER_B)
  await cleanupUser(DEMO_USER_ID)
  await prisma.$disconnect()
})

// ── A. Read isolation ─────────────────────────────────────────────

describe('A. Read isolation — user-b must never see user-a data', () => {
  it.each(READ_ENDPOINTS)('GET %s does not leak user-a records to user-b', async (path) => {
    const res = await request(app).get(path).set('X-Test-User', USER_B)
    assertNoLeak(res, userA.markers, `GET ${path} (as user-b)`)
  })

  it('GET /plaid-items never includes accessToken or cursor for either user', async () => {
    for (const userId of [USER_A, USER_B]) {
      const res = await request(app).get('/plaid-items').set('X-Test-User', userId)
      const text = JSON.stringify(res.body)
      expect(text.includes('"accessToken"'), `GET /plaid-items (as ${userId}) leaked an accessToken field`).toBe(false)
      expect(text.includes('"cursor"'), `GET /plaid-items (as ${userId}) leaked a cursor field`).toBe(false)
    }
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

  it('DELETE /plaid-items/:id (user-a item) as user-b -> 404, rows unchanged, Plaid never called', async () => {
    const itemBefore = await prisma.plaidItem.findUniqueOrThrow({ where: { id: userA.plaidItemId } })
    const accountBefore = await prisma.account.findUniqueOrThrow({ where: { id: userA.accountId } })
    const txCountBefore = await prisma.transaction.count({ where: { accountId: userA.accountId } })
    const itemRemoveCallsBefore = (plaidClient.itemRemove as any).mock.calls.length

    const res = await request(app)
      .delete(`/plaid-items/${userA.plaidItemId}`)
      .set('X-Test-User', USER_B)

    expect(res.status).toBe(404)

    const itemAfter = await prisma.plaidItem.findUniqueOrThrow({ where: { id: userA.plaidItemId } })
    expect(JSON.stringify(itemAfter)).toBe(JSON.stringify(itemBefore))

    const accountAfter = await prisma.account.findUniqueOrThrow({ where: { id: userA.accountId } })
    expect(JSON.stringify(accountAfter)).toBe(JSON.stringify(accountBefore))

    const txCountAfter = await prisma.transaction.count({ where: { accountId: userA.accountId } })
    expect(txCountAfter).toBe(txCountBefore)
    expect(txCountAfter).toBe(userA.transactionIds.length)

    // Ownership check must reject before ever reaching Plaid.
    expect((plaidClient.itemRemove as any).mock.calls.length).toBe(itemRemoveCallsBefore)
  })

  it('DELETE /plaid-items/:id (own item) as user-a -> succeeds, rows deleted', async () => {
    // A throwaway item, separate from userA's shared fixture (which later
    // tests in this file still depend on), so this destructive test can't
    // affect anything else regardless of execution order.
    const item = await prisma.plaidItem.create({
      data: {
        userId: USER_A,
        itemId: `${USER_A}-unlink-item`,
        accessToken: encrypt(`fake-access-token-${USER_A}-unlink`),
        institutionId: `ins_${USER_A}_unlink`,
        institutionName: `${USER_A}-Unlink-Bank`,
      },
    })
    const account = await prisma.account.create({
      data: {
        userId: USER_A,
        plaidItemId: item.id,
        plaidAccountId: `${USER_A}-unlink-acct`,
        name: `${USER_A}-Unlink-Checking`,
        type: 'depository',
        subtype: 'checking',
        currentBalance: '1.00',
        availableBalance: '1.00',
        isoCurrencyCode: 'USD',
      },
    })
    const tx = await prisma.transaction.create({
      data: {
        userId: USER_A,
        accountId: account.id,
        plaidTransactionId: `${USER_A}-unlink-tx-1`,
        date: new Date(),
        amount: '1.00',
        name: `${USER_A}-unlink-tx`,
        isoCurrencyCode: 'USD',
        pending: false,
      },
    })

    const res = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)

    expect(res.status).toBe(200)
    expect(await prisma.plaidItem.findUnique({ where: { id: item.id } })).toBeNull()
    expect(await prisma.account.findUnique({ where: { id: account.id } })).toBeNull()
    expect(await prisma.transaction.findUnique({ where: { id: tx.id } })).toBeNull()
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

  it('GET /plaid-items (demo mode) returns only the demo item', async () => {
    const res = await request(app).get('/plaid-items').set('X-Demo-Mode', '1')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({
      id: demoItem.id,
      institutionName: 'Demo Bank',
      status: 'healthy',
    })
  })

  it('DELETE /plaid-items/:id is blocked in demo mode with no DB change', async () => {
    const before = await prisma.plaidItem.findUniqueOrThrow({ where: { id: demoItem.id } })

    const res = await request(app).delete(`/plaid-items/${demoItem.id}`).set('X-Demo-Mode', '1')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ demo: true, ok: false })

    const after = await prisma.plaidItem.findUniqueOrThrow({ where: { id: demoItem.id } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })
})

// ── D. Unauthenticated ───────────────────────────────────────────────

describe('D. Unauthenticated — no headers means no data', () => {
  it.each(READ_ENDPOINTS)('GET %s with no auth headers returns no data', async (path) => {
    const res = await request(app).get(path)
    expect(res.status, `GET ${path} unexpectedly returned 200 with no auth`).not.toBe(200)
    assertNoLeak(res, [...userA.markers, ...userB.markers], `GET ${path} (unauthenticated)`)
  })

  it('DELETE /plaid-items/:id with no auth headers does not delete', async () => {
    const before = await prisma.plaidItem.findUniqueOrThrow({ where: { id: userA.plaidItemId } })

    const res = await request(app).delete(`/plaid-items/${userA.plaidItemId}`)

    expect(res.status, 'DELETE /plaid-items/:id unexpectedly returned 200 with no auth').not.toBe(200)

    const after = await prisma.plaidItem.findUniqueOrThrow({ where: { id: userA.plaidItemId } })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })
})

// ── E. Unlink — the Plaid /item/remove call is the billable part ──────
//
//  M7.0. A PlaidItem that is deleted locally but never removed at Plaid
//  keeps billing every month, so "did we actually call /item/remove?" is a
//  financial assertion, not a stylistic one. Section B already proves the
//  rows disappear; without the assertions here, turning unlink into a
//  local-only delete would pass the entire rest of this suite.

describe('E. Unlink — /item/remove must actually reach Plaid', () => {
  const itemRemove = () => plaidClient.itemRemove as any
  const itemGet = () => plaidClient.itemGet as any
  const tokenExchange = () => plaidClient.itemPublicTokenExchange as any

  // The shared stub returns a fixed item_id, and PlaidItem.itemId is @unique —
  // so any test that creates an item through the real exchange path must claim
  // its own, or the second such test dies on a constraint violation.
  function withFreshExchangedItem(itemId: string) {
    tokenExchange().mockResolvedValueOnce({
      data: { access_token: 'test-access-token', item_id: itemId },
    })
  }

  let seq = 0

  /** A throwaway item/account/transaction, isolated from the shared fixtures. */
  async function seedThrowaway(userId: string, rawToken: string, institutionId?: string) {
    const tag = `unlink-e${++seq}`
    const item = await prisma.plaidItem.create({
      data: {
        userId,
        itemId: `${userId}-${tag}-item`,
        accessToken: encrypt(rawToken),
        institutionId: institutionId ?? `ins_${userId}_${tag}`,
        institutionName: `${userId}-${tag}-Bank`,
      },
    })
    const account = await prisma.account.create({
      data: {
        userId,
        plaidItemId: item.id,
        plaidAccountId: `${userId}-${tag}-acct`,
        name: `${userId}-${tag}-Checking`,
        type: 'depository',
        subtype: 'checking',
        currentBalance: '1.00',
        availableBalance: '1.00',
        isoCurrencyCode: 'USD',
      },
    })
    const tx = await prisma.transaction.create({
      data: {
        userId,
        accountId: account.id,
        plaidTransactionId: `${userId}-${tag}-tx`,
        date: new Date(),
        amount: '1.00',
        name: `${userId}-${tag}-tx`,
        isoCurrencyCode: 'USD',
        pending: false,
      },
    })
    return { item, account, tx }
  }

  async function rowsExist(ids: { item: string; account: string; tx: string }) {
    return {
      item: (await prisma.plaidItem.findUnique({ where: { id: ids.item } })) !== null,
      account: (await prisma.account.findUnique({ where: { id: ids.account } })) !== null,
      tx: (await prisma.transaction.findUnique({ where: { id: ids.tx } })) !== null,
    }
  }

  // Only clear call history — the stub's default resolved value must survive,
  // since mockReset() would strip it and every later unlink would see undefined.
  beforeEach(() => {
    itemRemove().mockClear()
  })

  it('calls Plaid /item/remove exactly once, with the DECRYPTED access token', async () => {
    const rawToken = 'plaintext-token-for-remove-assertion'
    const { item } = await seedThrowaway(USER_A, rawToken)

    const res = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)

    expect(res.status).toBe(200)
    // The financial assertion: a local-only delete would leave this at 0.
    expect(itemRemove().mock.calls.length).toBe(1)
    expect(itemRemove().mock.calls[0][0]).toEqual({ access_token: rawToken })
  })

  it('leaves every local row intact when Plaid /item/remove fails', async () => {
    const { item, account, tx } = await seedThrowaway(USER_A, 'token-plaid-fails')
    const ids = { item: item.id, account: account.id, tx: tx.id }

    itemRemove().mockRejectedValueOnce({
      response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } },
    })

    const res = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)

    expect(res.status).toBe(500)
    // Deleting locally here would orphan a live, billing Item at Plaid.
    expect(await rowsExist(ids)).toEqual({ item: true, account: true, tx: true })
  })

  it.each(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'])(
    'still cleans up locally when Plaid reports %s (nothing left to bill)',
    async (errorCode) => {
      const { item, account, tx } = await seedThrowaway(USER_A, `token-${errorCode}`)
      const ids = { item: item.id, account: account.id, tx: tx.id }

      itemRemove().mockRejectedValueOnce({ response: { data: { error_code: errorCode } } })

      const res = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)

      expect(res.status).toBe(200)
      expect(await rowsExist(ids)).toEqual({ item: false, account: false, tx: false })
    },
  )

  it('is idempotent — a repeated DELETE returns 404 and does not re-call Plaid', async () => {
    const { item } = await seedThrowaway(USER_A, 'token-idempotency')

    const first = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)
    expect(first.status).toBe(200)
    expect(itemRemove().mock.calls.length).toBe(1)

    const second = await request(app).delete(`/plaid-items/${item.id}`).set('X-Test-User', USER_A)
    expect(second.status).toBe(404)
    // The ownership/existence check must short-circuit before reaching Plaid.
    expect(itemRemove().mock.calls.length).toBe(1)
  })

  it('re-linking an institution removes the superseded Item at Plaid', async () => {
    // Re-link is a second path that drops a PlaidItem. Before M7.0 it deleted
    // the old row locally and never called /item/remove, so every reconnect
    // silently orphaned a billable Item — the same financial bug as above.
    const institutionId = 'ins_relink_regression'
    const oldRawToken = 'old-token-superseded-by-relink'
    const { item, account, tx } = await seedThrowaway(USER_A, oldRawToken, institutionId)
    const ids = { item: item.id, account: account.id, tx: tx.id }

    // The re-link branch keys off institutionId, which comes from itemGet.
    itemGet().mockResolvedValueOnce({ data: { item: { institution_id: institutionId } } })
    withFreshExchangedItem('relink-regression-item')

    const res = await request(app)
      .post('/exchange_public_token')
      .set('X-Test-User', USER_A)
      .send({ public_token: 'public-test-relink' })

    expect(res.status).toBe(200)
    expect(itemRemove().mock.calls.length).toBe(1)
    expect(itemRemove().mock.calls[0][0]).toEqual({ access_token: oldRawToken })
    expect(await rowsExist(ids)).toEqual({ item: false, account: false, tx: false })

    // The replacement item exists and belongs to the same user.
    const replacement = await prisma.plaidItem.findFirst({
      where: { userId: USER_A, institutionId },
    })
    expect(replacement).not.toBeNull()
    expect(replacement!.id).not.toBe(item.id)
  })

  it('does not remove another user’s Item at Plaid when re-linking', async () => {
    // user-b re-links an institution whose id collides with a user-a item.
    // The lookup is userId-scoped, so user-a's Item must be left alone —
    // including at Plaid, where removing it would break a paying connection.
    const sharedInstitution = 'ins_shared_across_users'
    const victim = await seedThrowaway(USER_A, 'user-a-token-must-survive', sharedInstitution)

    itemGet().mockResolvedValueOnce({ data: { item: { institution_id: sharedInstitution } } })
    withFreshExchangedItem('relink-cross-user-item')

    const res = await request(app)
      .post('/exchange_public_token')
      .set('X-Test-User', USER_B)
      .send({ public_token: 'public-test-relink-b' })

    expect(res.status).toBe(200)
    expect(itemRemove().mock.calls.length).toBe(0)
    expect(
      await rowsExist({ item: victim.item.id, account: victim.account.id, tx: victim.tx.id }),
    ).toEqual({ item: true, account: true, tx: true })
  })
})
