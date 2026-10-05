// ─────────────────────────────────────────────────────────────────
//  Linking a bank the user may already have.
//
//  Before exchange (metadata from the browser — a cost and UX guard only):
//    - same institution and an overlapping account (same mask and subtype;
//      name breaks the tie where masks are null) → refused, DUPLICATE_ITEM;
//    - same institution, no overlap → asked, SAME_INSTITUTION, unless the
//      user has confirmed a different login;
//    - a null institution id never matches anything.
//  After exchange (the real guarantee): an overlap removes the NEW Item and
//  keeps the user's existing one and everything on it. An existing Item is
//  never removed by a new link. A failure after exchange never leaves a
//  billed Item we can't see: the Item is stored first, and removed at Plaid
//  if anything later fails; if that removal fails too, its item_id (never
//  the token) goes to Sentry.
//
//  All ids, names and masks are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
}))

import request from 'supertest'
import { app, plaidClient } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import * as plaidService from '../src/services/plaid.service'
const accountsOverlap = (a: object, b: object) => (plaidService as any).accountsOverlap(a, b)

const USER = 'link-dup-test-user'
const OTHER = 'link-dup-test-other'
const INST = 'ins_dup_test'
const mock = (name: keyof typeof plaidClient) => (plaidClient as any)[name] as ReturnType<typeof vi.fn>

let seq = 0
/** Make the next exchange create a fresh Item at "Plaid", with these accounts. */
function nextLink(institutionId: string | null, accounts: Array<{ name: string; mask: string | null; subtype: string }>) {
  const n = ++seq
  const itemId = `${USER}-new-item-${n}`
  const token = `access-new-${n}`
  mock('itemPublicTokenExchange').mockResolvedValueOnce({ data: { access_token: token, item_id: itemId } })
  mock('itemGet').mockResolvedValueOnce({ data: { item: { institution_id: institutionId } } })
  mock('accountsGet').mockResolvedValueOnce({
    data: {
      accounts: accounts.map((a, i) => ({
        account_id: `${itemId}-acct-${i}`, name: a.name, official_name: null, mask: a.mask,
        type: 'depository', subtype: a.subtype,
        balances: { current: 1, available: 1, iso_currency_code: 'USD' },
      })),
    },
  })
  return { itemId, token }
}

/** An Item the user already has, with one account and a tagged transaction. */
async function existing(userId: string, institutionId: string | null, acct: { name: string; mask: string | null; subtype: string }, tag = 'x') {
  const item = await prisma.plaidItem.create({
    data: { userId, itemId: `${userId}-old-${tag}`, accessToken: encrypt(`access-old-${userId}-${tag}`), institutionId, institutionName: 'Dup Test Bank' },
  })
  const account = await prisma.account.create({
    data: { userId, plaidItemId: item.id, plaidAccountId: `${userId}-old-${tag}-acct`, name: acct.name, mask: acct.mask, type: 'depository', subtype: acct.subtype, isoCurrencyCode: 'USD' },
  })
  const tx = await prisma.transaction.create({
    data: { userId, accountId: account.id, plaidTransactionId: `${userId}-old-${tag}-tx`, date: new Date(), amount: '5.00', name: 'OLD', tags: ['kept'], notes: 'kept' },
  })
  return { item, account, tx }
}

const link = (body: object, userId = USER) =>
  request(app).post('/exchange_public_token').set('X-Test-User', userId).send({ public_token: 'public-test', ...body })
const items = (userId = USER) => prisma.plaidItem.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })

async function cleanup() {
  for (const userId of [USER, OTHER]) {
    await prisma.transaction.deleteMany({ where: { userId } })
    await prisma.account.deleteMany({ where: { userId } })
    await prisma.plaidItem.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}

beforeEach(async () => {
  await cleanup()
  for (const name of ['itemPublicTokenExchange', 'itemGet', 'accountsGet', 'itemRemove'] as const) mock(name).mockClear()
  sentry.captureMessage.mockClear()
  for (const id of [USER, OTHER]) await prisma.user.create({ data: { id, email: `${id}@link-dup-test.local` } })
})

afterAll(cleanup)

const CHECKING = { name: 'Everyday Checking', mask: '1234', subtype: 'checking' }
const meta = (accounts: object[], institution_id: string | null = INST) => ({ institution_id, accounts })

describe('what counts as the same account', () => {
  it('same mask and subtype; name only where both masks are null', () => {
    expect(accountsOverlap(CHECKING, { ...CHECKING, name: 'Renamed' })).toBe(true)
    expect(accountsOverlap(CHECKING, { ...CHECKING, subtype: 'savings' })).toBe(false)
    expect(accountsOverlap(CHECKING, { ...CHECKING, mask: '9999' })).toBe(false)
    const noMask = { name: 'Joint Checking', mask: null, subtype: 'checking' }
    expect(accountsOverlap(noMask, { ...noMask })).toBe(true)
    expect(accountsOverlap(noMask, { ...noMask, name: 'Other' })).toBe(false)
    expect(accountsOverlap(noMask, { ...noMask, mask: '1234' })).toBe(false)
  })
})

describe('before exchange', () => {
  it('refuses an overlapping account at the same institution, without exchanging', async () => {
    const old = await existing(USER, INST, CHECKING)
    const res = await link(meta([CHECKING]))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'DUPLICATE_ITEM', itemId: old.item.id })
    expect(mock('itemPublicTokenExchange')).not.toHaveBeenCalled()
  })

  it('asks when the institution matches but no account does, without exchanging', async () => {
    const old = await existing(USER, INST, CHECKING)
    const res = await link(meta([{ name: 'Business Checking', mask: '5678', subtype: 'checking' }]))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'SAME_INSTITUTION', itemId: old.item.id })
    expect(mock('itemPublicTokenExchange')).not.toHaveBeenCalled()
  })

  it('exchanges once the user confirms a different login, and keeps the first Item', async () => {
    const old = await existing(USER, INST, CHECKING)
    nextLink(INST, [{ name: 'Business Checking', mask: '5678', subtype: 'checking' }])
    const res = await link({ ...meta([{ name: 'Business Checking', mask: '5678', subtype: 'checking' }]), confirmedNewLogin: true })
    expect(res.status).toBe(200)
    expect((await items()).map((i) => i.id)).toContain(old.item.id)
    expect(await items()).toHaveLength(2)
    expect(mock('itemRemove')).not.toHaveBeenCalled()
  })

  it('a null institution id never matches anything', async () => {
    await existing(USER, null, CHECKING)
    nextLink(null, [CHECKING])
    const res = await link(meta([CHECKING], null))
    expect(res.status).toBe(200)
    expect(await items()).toHaveLength(2)
    expect(mock('itemRemove')).not.toHaveBeenCalled()
  })
})

describe('after exchange (the real guarantee)', () => {
  it('removes the NEW Item when its accounts overlap, and keeps the old one and everything on it', async () => {
    const old = await existing(USER, INST, CHECKING)
    const fresh = nextLink(INST, [CHECKING])
    // No metadata: the browser's check was skipped or lied.
    const res = await link({})
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'DUPLICATE_ITEM', itemId: old.item.id })
    expect(mock('itemRemove')).toHaveBeenCalledTimes(1)
    expect(mock('itemRemove').mock.calls[0][0]).toEqual({ access_token: fresh.token })
    expect((await items()).map((i) => i.id)).toEqual([old.item.id])
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: old.tx.id } })).toMatchObject({ tags: ['kept'], notes: 'kept' })
  })

  it('never removes an existing Item, even at the same institution with different accounts', async () => {
    const old = await existing(USER, INST, CHECKING)
    nextLink(INST, [{ name: 'Savings', mask: '7777', subtype: 'savings' }])
    const res = await link({})
    expect(res.status).toBe(200)
    expect((await items()).map((i) => i.id)).toContain(old.item.id)
    expect(mock('itemRemove')).not.toHaveBeenCalled()
  })

  it("never touches another user's Item at the same institution", async () => {
    const theirs = await existing(OTHER, INST, CHECKING)
    nextLink(INST, [CHECKING])
    const res = await link({})
    expect(res.status).toBe(200)
    expect(await prisma.plaidItem.findUnique({ where: { id: theirs.item.id } })).not.toBeNull()
    expect(mock('itemRemove')).not.toHaveBeenCalled()
  })

  it('removes the new Item at Plaid when a later step fails, leaving nothing behind', async () => {
    const fresh = nextLink(INST, [CHECKING])
    mock('itemGet').mockReset()
    mock('itemGet').mockRejectedValueOnce(new Error('plaid down'))
    const res = await link({})
    expect(res.status).toBe(500)
    expect(mock('itemRemove').mock.calls.map((c) => c[0])).toEqual([{ access_token: fresh.token }])
    expect(await items()).toHaveLength(0)
    mock('itemGet').mockResolvedValue({ data: { item: { institution_id: null } } })
  })

  it('when that removal fails too, keeps the row and reports the item_id, never the token', async () => {
    const fresh = nextLink(INST, [CHECKING])
    mock('itemGet').mockReset()
    mock('itemGet').mockRejectedValueOnce(new Error('plaid down'))
    mock('itemRemove').mockRejectedValueOnce(Object.assign(new Error('remove failed'), { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } }))
    const res = await link({})
    expect(res.status).toBe(500)
    // Kept, so it can still be unlinked (which removes it at Plaid) or reported.
    expect((await items()).map((i) => i.itemId)).toEqual([fresh.itemId])
    const reported = JSON.stringify(sentry.captureMessage.mock.calls)
    expect(reported).toContain(fresh.itemId)
    expect(reported).not.toContain(fresh.token)
    mock('itemGet').mockResolvedValue({ data: { item: { institution_id: null } } })
  })

  it('two links of the same accounts at once leave one Item', async () => {
    const a = nextLink(INST, [CHECKING])
    const b = nextLink(INST, [CHECKING])
    const [ra, rb] = await Promise.all([link({}), link({})])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    expect(await items()).toHaveLength(1)
    expect(mock('itemRemove')).toHaveBeenCalledTimes(1)
    expect([a.token, b.token]).toContain(mock('itemRemove').mock.calls[0][0].access_token)
  })
})

describe('the "same login, other accounts" path', () => {
  it('an update link token with account selection, for the Item the user already has', async () => {
    const old = await existing(USER, INST, CHECKING)
    mock('linkTokenCreate').mockClear()
    const res = await request(app).post('/create-update-link-token').set('X-Test-User', USER)
      .send({ itemId: old.item.id, accountSelection: true })
    expect(res.status).toBe(200)
    const req = mock('linkTokenCreate').mock.calls[0][0]
    expect(req.access_token).toBe(`access-old-${USER}-x`)
    expect(req.update).toEqual({ account_selection_enabled: true })
  })

  it('sync adds an account the user shared through it', async () => {
    const old = await existing(USER, INST, CHECKING)
    mock('accountsBalanceGet').mockResolvedValueOnce({
      data: {
        accounts: [
          { account_id: old.account.plaidAccountId, name: CHECKING.name, official_name: null, mask: CHECKING.mask, type: 'depository', subtype: 'checking', balances: { current: 2, available: 2, iso_currency_code: 'USD' } },
          { account_id: `${USER}-added-acct`, name: 'Added Savings', official_name: null, mask: '4321', type: 'depository', subtype: 'savings', balances: { current: 3, available: 3, iso_currency_code: 'USD' } },
        ],
      },
    })
    const res = await request(app).post('/sync').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    expect(await prisma.account.findUnique({ where: { plaidAccountId: `${USER}-added-acct` } }))
      .toMatchObject({ userId: USER, plaidItemId: old.item.id, mask: '4321', subtype: 'savings' })
  })
})
