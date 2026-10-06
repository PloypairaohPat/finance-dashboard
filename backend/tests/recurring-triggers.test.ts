// ─────────────────────────────────────────────────────────────────
//  What refreshes recurring streams (M7.6 PR 2b-2): Plaid's webhooks and a
//  daily backstop. Never a page load or a user action (no-recurring-calls
//  test). All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/node')>()),
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
}))
// Plaid's signature check is its own test's business; here every webhook is genuine
// unless a test says otherwise.
const verify = vi.hoisted(() => ({ ok: true }))
vi.mock('../src/utils/verifyPlaidWebhook', () => ({ verifyPlaidWebhook: vi.fn(async () => verify.ok) }))

import request from 'supertest'
import { PlaidApi } from 'plaid'
import { app, plaidClient } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { refreshStaleItems, STREAMS_STALE_HOURS } from '../src/services/recurringStreams.service'

const USER = 'triggers-test-user'
const mock = (name: string) => (plaidClient as any)[name] as Mock
const ids: Record<string, string> = {}

const webhook = (body: object) => request(app).post('/webhook').set('Plaid-Verification', 'test').send(body)

/** Wait until `cond` holds, up to a deadline. Fire-and-forget work lands after the 200. */
async function until(cond: () => Promise<boolean> | boolean, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}
/** Give fire-and-forget work time to run, for tests asserting nothing happened. */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

const stamp = async (key: string) => (await prisma.plaidItem.findUniqueOrThrow({ where: { id: ids[key] } })).streamsRefreshedAt
const recurringTokens = () => mock('transactionsRecurringGet').mock.calls.map((c) => c[0].access_token)

async function cleanup() {
  await prisma.recurringStream.deleteMany({ where: { userId: USER } })
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.balanceSnapshot.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeEach(async () => {
  await cleanup()
  verify.ok = true
  sentry.captureException.mockClear()
  for (const [name, value] of Object.entries({
    transactionsRecurringGet: { data: { inflow_streams: [], outflow_streams: [], updated_datetime: '2026-10-06T00:00:00Z' } },
    transactionsSync: { data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'c' } },
    accountsGet: { data: { accounts: [] } },
  })) {
    mock(name).mockReset()
    mock(name).mockResolvedValue(value)
  }
  await prisma.user.create({ data: { id: USER, email: `${USER}@triggers-test.local` } })
  for (const key of ['one', 'two', 'three']) {
    const item = await prisma.plaidItem.create({
      data: { userId: USER, itemId: `${USER}-${key}`, accessToken: encrypt(`access-${key}`), institutionName: 'Test Bank' },
    })
    ids[key] = item.id
  }
})
afterAll(cleanup)

describe('RECURRING_TRANSACTIONS_UPDATE', () => {
  const update = (itemId: string) => webhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'RECURRING_TRANSACTIONS_UPDATE', item_id: itemId, account_ids: [] })

  it('refreshes that Item only, after answering Plaid', async () => {
    const res = await update(`${USER}-two`)
    expect(res.status).toBe(200)
    expect(await until(async () => (await stamp('two')) !== null)).toBe(true)
    expect(recurringTokens()).toEqual(['access-two'])
    expect(await stamp('one')).toBeNull()
    expect(await stamp('three')).toBeNull()
  })

  it('does nothing for an unknown item id', async () => {
    expect((await update('FAKE-not-an-item')).status).toBe(200)
    await settle()
    expect(mock('transactionsRecurringGet')).not.toHaveBeenCalled()
    expect(sentry.captureException).not.toHaveBeenCalled()
  })

  it('does nothing when the signature fails', async () => {
    verify.ok = false
    expect((await update(`${USER}-two`)).status).toBe(401)
    await settle()
    expect(mock('transactionsRecurringGet')).not.toHaveBeenCalled()
  })

  it('reports a failure to Sentry and leaves the stamp empty', async () => {
    mock('transactionsRecurringGet').mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { data: { error_code: 'PRODUCT_NOT_READY' } } }))
    await update(`${USER}-two`)
    expect(await until(() => sentry.captureException.mock.calls.length > 0)).toBe(true)
    expect(await stamp('two')).toBeNull()
  })
})

describe('the first refresh of a new link', () => {
  const syncUpdate = (itemId: string, historical: boolean) => webhook({
    webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: itemId,
    initial_update_complete: true, historical_update_complete: historical,
  })

  it('fires once its history is complete, after the sync that webhook starts', async () => {
    await syncUpdate(`${USER}-one`, true)
    expect(await until(async () => (await stamp('one')) !== null)).toBe(true)
    expect(recurringTokens()).toEqual(['access-one'])
    // After the sync, not alongside it: the last sync call precedes the recurring call.
    const lastSync = Math.max(...mock('transactionsSync').mock.invocationCallOrder)
    expect(lastSync).toBeLessThan(mock('transactionsRecurringGet').mock.invocationCallOrder[0])
  })

  it('fires only once: a later webhook with the same flag does not refresh again', async () => {
    await syncUpdate(`${USER}-one`, true)
    expect(await until(async () => (await stamp('one')) !== null)).toBe(true)
    const syncsBefore = mock('transactionsSync').mock.calls.length
    await syncUpdate(`${USER}-one`, true)
    expect(await until(() => mock('transactionsSync').mock.calls.length > syncsBefore)).toBe(true)
    await settle()
    expect(recurringTokens()).toEqual(['access-one'])
  })

  it('does not fire before history is complete', async () => {
    await syncUpdate(`${USER}-one`, false)
    expect(await until(() => mock('transactionsSync').mock.calls.length > 0)).toBe(true)
    await settle()
    expect(mock('transactionsRecurringGet')).not.toHaveBeenCalled()
  })
})

describe('the daily backstop', () => {
  it('refreshes Items never refreshed or stale, carries on past a failure, and skips fresh ones', async () => {
    const now = new Date()
    await prisma.plaidItem.update({ where: { id: ids.three }, data: { streamsRefreshedAt: new Date(now.getTime() - 2 * 3_600_000) } }) // fresh
    await prisma.plaidItem.update({ where: { id: ids.two }, data: { streamsRefreshedAt: new Date(now.getTime() - (STREAMS_STALE_HOURS + 1) * 3_600_000) } }) // stale
    // Item one (never refreshed) fails; the loop must still reach item two.
    mock('transactionsRecurringGet').mockImplementation(async ({ access_token }: { access_token: string }) => {
      if (access_token === 'access-one') throw Object.assign(new Error('boom'), { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } })
      return { data: { inflow_streams: [], outflow_streams: [], updated_datetime: '2026-10-06T00:00:00Z' } }
    })
    const res = await refreshStaleItems(plaidClient, now)
    // The backstop covers every non-demo Item in the database (the shared test
    // database holds other files' Items too), so look at this user's three.
    expect(res.failed).toBeGreaterThanOrEqual(1)
    const ours = recurringTokens().filter((t) => ['access-one', 'access-two', 'access-three'].includes(t))
    expect(ours.sort()).toEqual(['access-one', 'access-two'])
    expect(await stamp('one')).toBeNull()
    expect((await stamp('two'))!.getTime()).toBeGreaterThan(now.getTime() - 60_000)
    expect(sentry.captureException).toHaveBeenCalled()
  })
})

describe('the demo', () => {
  it('never refreshes: not by webhook, not by the backstop', async () => {
    const demo = await prisma.user.upsert({ where: { id: 'demo-user' }, update: {}, create: { id: 'demo-user' } })
    const demoItem = await prisma.plaidItem.upsert({
      where: { itemId: 'demo-item-triggers-test' }, update: {},
      create: { userId: demo.id, itemId: 'demo-item-triggers-test', accessToken: 'DEMO-NO-TOKEN', institutionName: 'Demo Bank' },
    })
    try {
      // Mark this test user's Items fresh so only the demo's could be due.
      await prisma.plaidItem.updateMany({ where: { userId: USER }, data: { streamsRefreshedAt: new Date() } })
      await webhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'RECURRING_TRANSACTIONS_UPDATE', item_id: 'demo-item-triggers-test' })
      await settle()
      await refreshStaleItems(new PlaidApi() as PlaidApi) // a fresh client: any call would be visible below
      expect(mock('transactionsRecurringGet')).not.toHaveBeenCalled()
      expect((await prisma.plaidItem.findUniqueOrThrow({ where: { id: demoItem.id } })).streamsRefreshedAt).toBeNull()
      // Refused quietly, not tried and failed (its placeholder token can't even be decrypted).
      expect(sentry.captureException).not.toHaveBeenCalled()
    } finally {
      await prisma.plaidItem.delete({ where: { id: demoItem.id } })
    }
  })
})
