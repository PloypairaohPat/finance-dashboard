// ─────────────────────────────────────────────────────────────────
//  A new link asks Plaid for 180 days of transaction history (M7.6 PR 0b),
//  which Plaid recommends for Recurring Transactions; the default is 90.
//
//  It applies only when Transactions is first initialised on an Item: "once
//  Transactions has been added to an Item, this value cannot be updated"
//  (Plaid's /link/token/create docs). So the update-mode token — Reconnect,
//  and adding accounts — leaves it out.
//
//  All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it, type Mock } from 'vitest'
import request from 'supertest'
import { app, plaidClient } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'link-history-test-user'
const linkTokenCreate = () => (plaidClient as any).linkTokenCreate as Mock
let itemId = ''

async function cleanup() {
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@link-history-test.local` } })
  itemId = (await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`fake-token-${USER}`), institutionName: 'Test Bank' },
  })).id
})
afterAll(cleanup)

describe('link tokens', () => {
  it('a new link requests 180 days of transaction history', async () => {
    linkTokenCreate().mockClear()
    const res = await request(app).post('/create_link_token').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    expect(linkTokenCreate()).toHaveBeenCalledTimes(1)
    expect(linkTokenCreate().mock.calls[0][0].transactions).toEqual({ days_requested: 180 })
  })

  it.each([
    ['Reconnect', {}],
    ['adding accounts', { accountSelection: true }],
  ])('the update-mode token (%s) leaves history alone', async (_why, extra) => {
    linkTokenCreate().mockClear()
    const res = await request(app).post('/create-update-link-token').set('X-Test-User', USER).send({ itemId, ...extra })
    expect(res.status).toBe(200)
    const req = linkTokenCreate().mock.calls[0][0]
    expect(req.access_token).toBe(`fake-token-${USER}`)
    expect(req).not.toHaveProperty('transactions')
    expect(req).not.toHaveProperty('products')
  })
})
