// ─────────────────────────────────────────────────────────────────
//  Refreshing one Item's recurring streams (M7.6 PR 2a): fetch + apply.
//  Nothing in the app calls it yet; these tests call it directly.
//
//  All ids, names and amounts are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
}))

import request from 'supertest'
import { PlaidApi } from 'plaid'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { lockUserRows } from '../src/lib/userLock'
import {
  RefreshRefused, StreamFetchError, applyItemStreams, fetchItemStreams, refreshItemStreams,
} from '../src/services/recurringStreams.service'

const USER = 'refresh-test-user'
const ACCT = `${USER}-acct`
let itemId = ''

const s = (id: string, over: Record<string, unknown> = {}) => ({
  stream_id: `FAKE-${id}`, account_id: ACCT, description: id.toUpperCase(), merchant_name: id,
  personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
  frequency: 'MONTHLY', status: 'MATURE', is_active: true, first_date: '2026-06-05', last_date: '2026-09-05',
  predicted_next_date: '2026-10-05', average_amount: { amount: 10, iso_currency_code: 'USD' },
  last_amount: { amount: 10, iso_currency_code: 'USD' }, transaction_ids: [`FAKEtx-${id}`], ...over,
})

/** A Plaid client whose recurring call answers once with `outflow` (and `inflow`). */
function plaidWith(outflow: object[], inflow: object[] = []) {
  const c = new PlaidApi() as any
  ;(c.transactionsRecurringGet as Mock).mockResolvedValueOnce({
    data: { outflow_streams: outflow, inflow_streams: inflow, updated_datetime: '2026-10-05T12:00:00Z' },
  })
  return c as PlaidApi
}

const stored = () => prisma.recurringStream.findMany({ where: { userId: USER }, orderBy: { streamId: 'asc' } })

async function cleanup() {
  await prisma.recurringStream.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeEach(async () => {
  await cleanup()
  sentry.captureException.mockClear()
  await prisma.user.create({ data: { id: USER, email: `${USER}@refresh-test.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: USER, itemId: `${USER}-item`, accessToken: encrypt(`access-${USER}`), institutionName: 'Test Bank' },
  })
  itemId = item.id
  await prisma.account.create({
    data: { userId: USER, plaidItemId: item.id, plaidAccountId: ACCT, name: 'Checking', type: 'depository', isoCurrencyCode: 'USD' },
  })
})
afterAll(cleanup)

describe('refreshItemStreams', () => {
  it('upserts by (Item, stream_id): a second refresh updates, never duplicates', async () => {
    expect(await refreshItemStreams(plaidWith([s('a'), s('b')]), itemId)).toMatchObject({ written: 2, removed: 0 })
    await refreshItemStreams(plaidWith([s('a', { last_amount: { amount: 12 } }), s('b')]), itemId)
    const rows = await stored()
    expect(rows.map((r) => r.streamId)).toEqual(['FAKE-a', 'FAKE-b'])
    expect(Number(rows[0].lastAmount)).toBe(12)
  })

  it("removes the Item's streams Plaid didn't return", async () => {
    await refreshItemStreams(plaidWith([s('a'), s('b')]), itemId)
    expect(await refreshItemStreams(plaidWith([s('a')]), itemId)).toMatchObject({ written: 1, removed: 1 })
    expect((await stored()).map((r) => r.streamId)).toEqual(['FAKE-a'])
  })

  it("leaves out streams on accounts we don't hold", async () => {
    const res = await refreshItemStreams(plaidWith([s('a'), s('elsewhere', { account_id: 'FAKE-not-ours' })]), itemId)
    expect(res).toMatchObject({ written: 1, droppedForAccounts: 1 })
    expect((await stored()).map((r) => r.streamId)).toEqual(['FAKE-a'])
  })

  it('a Plaid error changes nothing and goes to Sentry', async () => {
    await refreshItemStreams(plaidWith([s('a')]), itemId)
    const before = await stored()
    const c = new PlaidApi() as any
    ;(c.transactionsRecurringGet as Mock).mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { data: { error_code: 'PRODUCT_NOT_READY' } } }))
    await expect(refreshItemStreams(c, itemId)).rejects.toBeInstanceOf(StreamFetchError)
    expect(await stored()).toEqual(before)
    expect(sentry.captureException).toHaveBeenCalledTimes(1)
    const reported = JSON.stringify(sentry.captureException.mock.calls)
    expect(reported).toContain(`${USER}-item`)
    expect(reported).not.toContain(`access-${USER}`)
  })

  it("a successful empty response is real: it clears the Item's streams", async () => {
    await refreshItemStreams(plaidWith([s('a'), s('b')]), itemId)
    expect(await refreshItemStreams(plaidWith([]), itemId)).toMatchObject({ written: 0, removed: 2 })
    expect(await stored()).toEqual([])
  })

  it('is a quiet no-op when the Item has gone by the time it applies', async () => {
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } })
    const fetched = await fetchItemStreams(plaidWith([s('a')]), item)
    await prisma.account.deleteMany({ where: { plaidItemId: itemId } })
    await prisma.plaidItem.delete({ where: { id: itemId } })
    expect(await prisma.$transaction((tx) => applyItemStreams(tx, fetched))).toMatchObject({ skipped: true, written: 0 })
    expect(await stored()).toEqual([])
  })
})

describe('the per-user lock', () => {
  const settled = async (p: Promise<unknown>, ms = 400) =>
    Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))])

  it('apply waits for an unlink holding the lock, then finds the Item gone', async () => {
    let refresh: Promise<unknown> = Promise.resolve()
    await prisma.$transaction(async (tx) => {
      await lockUserRows(tx, USER)
      refresh = refreshItemStreams(plaidWith([s('a')]), itemId)
      expect(await settled(refresh)).toBe(false) // waiting for the lock
      // The "unlink", inside the lock.
      await tx.account.deleteMany({ where: { plaidItemId: itemId } })
      await tx.plaidItem.delete({ where: { id: itemId } })
    }, { timeout: 10_000 })
    expect(await refresh).toMatchObject({ skipped: true })
    expect(await stored()).toEqual([])
  })

  it('unlink waits for a refresh holding the lock', async () => {
    let unlink: Promise<unknown> = Promise.resolve()
    await prisma.$transaction(async (tx) => {
      await lockUserRows(tx, USER)
      unlink = request(app).delete(`/plaid-items/${itemId}`).set('X-Test-User', USER).then((r) => r.status)
      expect(await settled(unlink)).toBe(false)
    }, { timeout: 10_000 })
    expect(await unlink).toBe(200)
  })
})

describe('the demo', () => {
  it('refuses the demo user and demo Items, without calling Plaid', async () => {
    const c = new PlaidApi() as any
    const call = c.transactionsRecurringGet as Mock
    call.mockClear()
    await expect(fetchItemStreams(c, { id: 'x', userId: 'demo-user', itemId: 'demo-item-1', accessToken: 'whatever' })).rejects.toBeInstanceOf(RefreshRefused)
    await expect(fetchItemStreams(c, { id: 'x', userId: USER, itemId: 'demo-item-1', accessToken: 'DEMO-NO-TOKEN' })).rejects.toBeInstanceOf(RefreshRefused)
    await expect(prisma.$transaction((tx) => applyItemStreams(tx, { plaidItemId: 'x', userId: 'demo-user', plaidUpdatedAt: new Date(), streams: [] })))
      .rejects.toBeInstanceOf(RefreshRefused)
    expect(call).not.toHaveBeenCalled()
  })
})
