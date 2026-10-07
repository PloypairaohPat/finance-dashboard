// ─────────────────────────────────────────────────────────────────
//  The Sync button refreshes recurring streams too (M7.6 PR 5e): after the
//  transaction sync, not alongside it; skipping an Item refreshed in the last
//  SYNC_REFRESH_COOLDOWN_MINUTES; a refresh failure reported and the sync
//  still successful; never for the demo. And GET /subscriptions says how
//  fresh the streams are, by the stalest Item. All ids are invented.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

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
import { SYNC_REFRESH_COOLDOWN_MINUTES } from '../src/services/recurringStreams.service'

const USER = 'sync-refresh-test-user'
const mock = (name: string) => (plaidClient as any)[name] as Mock
const ids: Record<string, string> = {}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

async function cleanup() {
  for (const t of ['recurringStream', 'balanceSnapshot', 'transaction', 'account', 'plaidItem'] as const) {
    await (prisma[t] as any).deleteMany({ where: { userId: USER } })
  }
  await prisma.user.deleteMany({ where: { id: USER } })
}

const sync = () => request(app).post('/sync').set('X-Test-User', USER)
const stamp = async (key: string) => (await prisma.plaidItem.findUniqueOrThrow({ where: { id: ids[key] } })).streamsRefreshedAt
const recurringTokens = () => mock('transactionsRecurringGet').mock.calls.map((c) => c[0].access_token)

beforeEach(async () => {
  await cleanup()
  sentry.captureException.mockClear(); sentry.captureMessage.mockClear()
  for (const [name, value] of Object.entries({
    transactionsRecurringGet: { data: { inflow_streams: [], outflow_streams: [], updated_datetime: '2026-10-07T00:00:00Z' } },
    transactionsSync: { data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'c' } },
    accountsGet: { data: { accounts: [] } },
  })) {
    mock(name).mockReset()
    mock(name).mockResolvedValue(value)
  }
  await prisma.user.create({ data: { id: USER, email: `${USER}@sync-refresh-test.local` } })
  for (const key of ['one', 'two']) {
    const item = await prisma.plaidItem.create({
      data: { userId: USER, itemId: `${USER}-${key}`, accessToken: encrypt(`access-${key}`), institutionName: 'Test Bank' },
    })
    ids[key] = item.id
  }
})
afterAll(cleanup)

describe('POST /sync refreshes streams', () => {
  it('after each Item\'s transaction sync, not alongside it', async () => {
    const res = await sync()
    expect(res.status).toBe(200)
    expect(res.body.streams).toEqual({ refreshed: 2, skipped: 0, failed: 0 })
    expect(recurringTokens().sort()).toEqual(['access-one', 'access-two'])
    const lastSync = Math.max(...mock('transactionsSync').mock.invocationCallOrder)
    expect(lastSync).toBeLessThan(Math.min(...mock('transactionsRecurringGet').mock.invocationCallOrder))
    expect(await stamp('one')).not.toBeNull()
  })

  it(`skips an Item refreshed in the last ${SYNC_REFRESH_COOLDOWN_MINUTES} minutes, and refreshes one past it`, async () => {
    await prisma.plaidItem.update({ where: { id: ids.one }, data: { streamsRefreshedAt: minutesAgo(SYNC_REFRESH_COOLDOWN_MINUTES - 1) } })
    await prisma.plaidItem.update({ where: { id: ids.two }, data: { streamsRefreshedAt: minutesAgo(SYNC_REFRESH_COOLDOWN_MINUTES + 1) } })
    const res = await sync()
    expect(res.body.streams).toEqual({ refreshed: 1, skipped: 1, failed: 0 })
    expect(recurringTokens()).toEqual(['access-two'])
  })

  it('pressing Sync twice in a row calls Plaid for streams once', async () => {
    await sync()
    await sync()
    expect(recurringTokens().sort()).toEqual(['access-one', 'access-two'])
  })

  it('a stream refresh failure is reported, and the sync still succeeds', async () => {
    mock('transactionsRecurringGet').mockRejectedValue(Object.assign(new Error('boom'), { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } }))
    const res = await sync()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ added: 0, modified: 0, removed: 0, streams: { refreshed: 0, failed: 2 } })
    expect(sentry.captureException).toHaveBeenCalled()
    expect(await stamp('one')).toBeNull()
  })

  it("an Item whose transaction sync failed isn't refreshed", async () => {
    mock('transactionsSync').mockImplementation(async ({ access_token }: { access_token: string }) => {
      if (access_token === 'access-one') throw Object.assign(new Error('login'), { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } })
      return { data: { added: [], modified: [], removed: [], has_more: false, next_cursor: 'c' } }
    })
    await sync()
    expect(recurringTokens()).toEqual(['access-two'])
  })

  it('is refused for the demo, with no call to Plaid', async () => {
    const res = await request(app).post('/sync').set('X-Demo-Mode', '1')
    expect(res.body).toMatchObject({ demo: true, ok: false })
    expect(mock('transactionsRecurringGet')).not.toHaveBeenCalled()
  })
})

describe('GET /subscriptions says how fresh the streams are', () => {
  const freshness = async (as: Record<string, string>) => (await request(app).get('/subscriptions').set(as)).body.freshness

  it('by the least recently refreshed Item', async () => {
    const older = minutesAgo(180), newer = minutesAgo(5)
    await prisma.plaidItem.update({ where: { id: ids.one }, data: { streamsRefreshedAt: newer } })
    await prisma.plaidItem.update({ where: { id: ids.two }, data: { streamsRefreshedAt: older } })
    expect(await freshness({ 'X-Test-User': USER })).toEqual({ oldest: older.toISOString() })
  })

  it('as never, while one Item has never been refreshed', async () => {
    await prisma.plaidItem.update({ where: { id: ids.one }, data: { streamsRefreshedAt: minutesAgo(5) } })
    expect(await freshness({ 'X-Test-User': USER })).toEqual({ oldest: null })
  })

  it('not at all for the demo, whose Items are never refreshed', async () => {
    expect(await freshness({ 'X-Demo-Mode': '1' })).toBeNull()
  })
})
