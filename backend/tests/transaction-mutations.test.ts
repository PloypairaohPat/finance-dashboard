// ─────────────────────────────────────────────────────────────────
//  What a user can set on a row that has been replaced, or that is still
//  pending.
//
//  Replaced (soft-deleted, e.g. a pending row Plaid removed when it
//  posted): every mutation answers 404 and changes nothing. A panel left
//  open across a sync used to save into the deleted row and say it worked.
//
//  Pending: tags, notes and category are refused (409), like verdict
//  overrides and marks. A pending row is replaced by a new one when it
//  posts, so anything set on it is lost. Sending the values a row already
//  has is not a change, and is accepted.
//
//  All names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'tx-mutations-test-user'
const ids: Record<string, string> = {}

async function cleanup() {
  await prisma.subscriptionMark.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@mutations-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: `${USER}-Bank` },
  })
  const account = await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-checking`, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
  const today = new Date()
  const rows: Array<[string, number, string, string, boolean, boolean, object[]]> = [
    // key, amount, primary, detailed, pending, replaced, counterparties
    ['replaced-spend', 18, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT', true, true, []],
    ['replaced-app-in', -60, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', false, true, [{ name: 'Venmo', type: 'payment_app' }]],
    ['pending-spend', 23, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT', true, false, []],
    ['posted-spend', 31, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT', false, false, []],
  ]
  for (const [key, amount, primary, detailed, pending, replaced, counterparties] of rows) {
    const t = await prisma.transaction.create({
      data: {
        userId: USER, accountId: account.id, plaidTransactionId: `${USER}-${key}`, date: today,
        amount: amount.toFixed(2), name: key.toUpperCase(), cleanName: key.toUpperCase(),
        categoryPrimary: primary, categoryDetailed: detailed, pending, isoCurrencyCode: 'USD',
        tags: ['before'], notes: 'before',
        deletedAt: replaced ? new Date() : null,
        merchantEntityId: null, counterpartyEntities: [],
        rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' }, counterparties },
      },
    })
    ids[key] = t.id
  }
})

afterAll(cleanup)

const patch = (key: string, body: object) =>
  request(app).patch(`/transactions/${ids[key]}`).set('X-Test-User', USER).send(body)
const row = (key: string) => prisma.transaction.findUniqueOrThrow({ where: { id: ids[key] } })

describe('a replaced (soft-deleted) row', () => {
  it.each([
    ['tags', 'replaced-spend', { tags: ['after'] }],
    ['notes', 'replaced-spend', { notes: 'after' }],
    ['category', 'replaced-spend', { category: 'Shopping' }],
    ['verdictOverride', 'replaced-app-in', { verdictOverride: 'income' }],
  ])('PATCH %s -> 404, row unchanged', async (_field, key, body) => {
    const before = await row(key)
    const res = await patch(key, body)
    expect(res.status).toBe(404)
    expect(await row(key)).toEqual(before)
  })

  it('POST /subscriptions/marks -> 404, no mark written', async () => {
    const res = await request(app).post('/subscriptions/marks').set('X-Test-User', USER).send({ transactionId: ids['replaced-spend'] })
    expect(res.status).toBe(404)
    expect(await prisma.subscriptionMark.count({ where: { userId: USER } })).toBe(0)
  })

  it('GET /subscriptions/marks/membership -> 404', async () => {
    const res = await request(app).get(`/subscriptions/marks/membership/${ids['replaced-spend']}`).set('X-Test-User', USER)
    expect(res.status).toBe(404)
  })
})

describe('a pending row', () => {
  it.each([
    ['tags', { tags: ['after'] }],
    ['notes', { notes: 'after' }],
    ['category', { category: 'Shopping' }],
  ])('PATCH %s -> 409, row unchanged', async (_field, body) => {
    const before = await row('pending-spend')
    const res = await patch('pending-spend', body)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/once it posts/)
    expect(await row('pending-spend')).toEqual(before)
  })

  it('accepts the values it already has: sending them is not a change', async () => {
    const res = await patch('pending-spend', { tags: ['before'], notes: 'before' })
    expect(res.status).toBe(200)
  })

  it('says it is pending, so the panel can show it and hold the fields', async () => {
    const res = await request(app).get('/transactions/search').set('X-Test-User', USER)
    const by = new Map((res.body.transactions as Array<{ id: string; pending: boolean; categoryEditable: boolean }>).map((t) => [t.id, t]))
    expect(by.get(ids['pending-spend'])).toMatchObject({ pending: true, categoryEditable: false })
    expect(by.get(ids['posted-spend'])).toMatchObject({ pending: false })
  })
})

describe('a posted row', () => {
  it('still takes tags, notes and category', async () => {
    const res = await patch('posted-spend', { tags: ['after'], notes: 'after', category: 'Shopping' })
    expect(res.status).toBe(200)
    expect(await row('posted-spend')).toMatchObject({ tags: ['after'], notes: 'after' })
  })
})
