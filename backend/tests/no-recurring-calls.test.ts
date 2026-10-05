// ─────────────────────────────────────────────────────────────────
//  Loading the Subscriptions tab or the bell never calls Plaid's
//  /transactions/recurring/get (M7.6 PR 0).
//
//  GET /subscriptions used to call it on every load, for every Item, outside
//  the Plaid rate limiter, for a "Plaid half" that read renamed fields and
//  never produced a stream (docs/m7.6-audit.md). GET /recurring, unused by the
//  frontend, did the same. PR 2 brings recurring streams back as stored data,
//  fetched on a webhook or a schedule — never on a page load.
//
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import request from 'supertest'
import { app, plaidClient as appPlaidClient } from '../src/app'
import { plaidClient as libPlaidClient } from '../src/lib/plaidClient'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'no-recurring-test-user'

/** The recurring method on BOTH Plaid clients: the app's and the library's. */
const recurring = () => [appPlaidClient, libPlaidClient].map((c) => (c as any).transactionsRecurringGet as Mock)
const recurringCalls = () => recurring().reduce((n, f) => n + f.mock.calls.length, 0)

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@recurring-test.local` } })
  // A real user with an Item and an account: exactly what made the old code call Plaid.
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: 'Test Bank' },
  })
  await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-acct`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
})
afterAll(cleanup)

describe('page loads never call /transactions/recurring/get', () => {
  it('the counter can see a call on either client', async () => {
    // Guards against a blind spy (the mocks live on instances, not the prototype).
    expect(recurring().every((f) => vi.isMockFunction(f))).toBe(true)
    const before = recurringCalls()
    await libPlaidClient.transactionsRecurringGet({ access_token: 'self-check' })
    expect(recurringCalls()).toBe(before + 1)
  })

  it.each([
    ['a real user', { 'X-Test-User': USER }],
    ['the demo user', { 'X-Demo-Mode': '1' }],
  ])('GET /subscriptions and GET /alerts, as %s', async (_who, headers) => {
    recurring().forEach((f) => f.mockClear())
    expect((await request(app).get('/subscriptions').set(headers)).status).toBe(200)
    expect((await request(app).get('/alerts').set(headers)).status).toBe(200)
    expect(recurringCalls()).toBe(0)
  })
})

describe('GET /recurring', () => {
  it('is gone', async () => {
    const res = await request(app).get('/recurring').set('X-Test-User', USER)
    expect(res.status).toBe(404)
    expect(recurringCalls()).toBe(0)
  })
})
