// ─────────────────────────────────────────────────────────────────
//  tests/subscription-price-up.test.ts — the alert path reads stored data only,
//  and subscription_price_up works.
//
//  Until this fix the bell's subscription input came from a Plaid call made on
//  every bell open, and subscriptionPriceUp read fields that don't exist, so it
//  never fired. These are written against behaviour that exists before and
//  after the fix (GET /alerts, GET /subscriptions, runDetectors, stored alert
//  rows), so the same file shows the old code failing.
//
//  A test that a dead detector would pass by doing nothing carries a positive
//  control in the same test, so "ignores bills" can't pass just because
//  nothing fires at all.
//
//  Everything here is invented: merchant names, amounts and dates.
// ─────────────────────────────────────────────────────────────────

import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import request from 'supertest'
import { app, plaidClient as appPlaidClient } from '../src/app'
import { plaidClient as libPlaidClient } from '../src/lib/plaidClient'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { runDetectors } from '../src/services/alerts/dispatcher'
import { detectSubscriptionPriceUp } from '../src/services/alerts/detectors/subscriptionPriceUp'
import type { DetectorContext } from '../src/services/alerts/types'

// Lets one test make the bell's subscription input unreadable. Wraps whichever
// of the two entry points exists, so the file runs against old and new code.
const failInput = vi.hoisted(() => ({ on: false }))
vi.mock('../src/services/subscriptions.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const guard = (name: string) => {
    const fn = actual[name]
    if (typeof fn !== 'function') return {}
    return {
      [name]: (...args: unknown[]) =>
        failInput.on ? Promise.reject(new Error('subscription input unavailable')) : (fn as (...a: unknown[]) => unknown)(...args),
    }
  }
  return { ...actual, ...guard('fetchSubscriptionAnalysis'), ...guard('analyseStoredSubscriptions') }
})

const DAY_MS = 86_400_000
const PREFIX = 'price-up-test-'
const today = () => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}
const daysAgo = (n: number) => new Date(today() - n * DAY_MS)

/**
 * Counts every Plaid call, on both clients: the app's (GET /subscriptions) and
 * lib/plaidClient's (the alert path). tests/setup.ts already replaces Plaid with
 * a mock whose methods are vi.fn() OWN properties of each instance — not
 * prototype methods — so that is what gets counted.
 *
 * It checks itself before use. A first version spied on PlaidApi.prototype,
 * which under the mock has no methods, counted nothing, and let a "zero Plaid
 * calls" test pass against code that called Plaid on every bell open.
 */
function spyOnPlaid() {
  const fns = [appPlaidClient, libPlaidClient].flatMap((c) =>
    Object.values(c as unknown as Record<string, unknown>).filter((f): f is Mock => vi.isMockFunction(f)),
  )
  const calls = () => fns.reduce((n, f) => n + f.mock.calls.length, 0)
  fns.forEach((f) => f.mockClear())
  void libPlaidClient.itemGet({ access_token: 'self-check' })
  if (fns.length === 0 || calls() !== 1) throw new Error('the Plaid call counter cannot see Plaid calls')
  fns.forEach((f) => f.mockClear())
  return { calls }
}

const users: string[] = []

async function makeUser(name: string) {
  const id = `${PREFIX}${name}`
  users.push(id)
  await prisma.user.create({ data: { id, email: `${id}@price-up.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`fake-${id}`), institutionName: 'Test Bank' },
  })
  const account = (n: string, type: string, subtype: string) =>
    prisma.account.create({
      data: {
        userId: id, plaidItemId: item.id, plaidAccountId: `${id}-${n}`, name: n, type, subtype,
        currentBalance: '500.00', isoCurrencyCode: 'USD',
      },
    })
  const card = await account('Card', 'credit', 'credit card')
  await account('Checking', 'depository', 'checking')
  return { id, cardId: card.id }
}

/** A card purchase: ordinary spend, which is what subscription detection reads. */
type Code = readonly [primary: string, detailed: string]
const TV: Code = ['ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES']
const MUSIC: Code = ['ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO']
const WATER: Code = ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_WATER']

async function charge(user: { id: string; cardId: string }, name: string, amount: number, ago: number, [primary, detailed]: Code) {
  await prisma.transaction.create({
    data: {
      userId: user.id, accountId: user.cardId, plaidTransactionId: `${user.id}-${name}-${ago}`,
      date: daysAgo(ago), amount: amount.toFixed(2), name, cleanName: name,
      categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD', pending: false,
      rawJson: {
        personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' },
        counterparties: [{ name, type: 'merchant' }],
      },
    },
  })
}

/** Four charges 25 days apart, the last one moved to `last`. */
async function stream(user: { id: string; cardId: string }, name: string, base: number, last: number, code: Code) {
  for (const ago of [77, 52, 27]) await charge(user, name, base, ago, code)
  await charge(user, name, last, 2, code)
}

const priceUp = (userId: string) =>
  prisma.alert.findMany({ where: { userId, kind: 'subscription_price_up' }, orderBy: { fingerprint: 'asc' } })

async function cleanup() {
  for (const id of users) {
    await prisma.alert.deleteMany({ where: { userId: id } })
    await prisma.transaction.deleteMany({ where: { userId: id } })
    await prisma.account.deleteMany({ where: { userId: id } })
    await prisma.plaidItem.deleteMany({ where: { userId: id } })
    await prisma.user.deleteMany({ where: { id } })
  }
}

beforeAll(async () => {
  // Leftovers from an interrupted run.
  const stale = await prisma.user.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true } })
  users.push(...stale.map((u) => u.id))
  await cleanup()
  users.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  failInput.on = false
})
afterAll(cleanup)

describe('the bell reads stored data only', () => {
  it('GET /alerts makes zero Plaid calls for a real user with a linked Item', async () => {
    const u = await makeUser('no-plaid')
    await stream(u, 'VIEWLOOM.COM', 9.99, 11.99, TV)
    const plaid = spyOnPlaid()
    const res = await request(app).get('/alerts').set('X-Test-User', u.id)
    expect(res.status).toBe(200)
    expect(plaid.calls()).toBe(0)
  })

  it('GET /alerts returns normally for the demo user, whose token is a placeholder', async () => {
    const plaid = spyOnPlaid()
    const res = await request(app).get('/alerts').set('X-Demo-Mode', '1')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(plaid.calls()).toBe(0)
  })
})

describe('subscription_price_up', () => {
  it('fires for a subscription rise inside the lookback — and not for a bill, or a sub-threshold move', async () => {
    const u = await makeUser('fires')
    await stream(u, 'VIEWLOOM.COM', 9.99, 11.99, TV) // +20%: a subscription rise
    await stream(u, 'CITY WATER CO', 60, 75, WATER)          // +25%, but a bill
    await stream(u, 'TUNEFLOW', 10, 10.4, MUSIC)        // +4%: under the service's 5%
    spyOnPlaid()
    await runDetectors(u.id)

    const alerts = await priceUp(u.id)
    expect(alerts).toHaveLength(1) // the control: exactly the subscription rise
    expect(alerts[0].fingerprint).toMatch(/^price_up:viewloom:\d{4}-\d{2}-\d{2}$/)
    expect(alerts[0].resolvedAt).toBeNull()
  })

  it('ages out once the raised charge is older than the lookback', async () => {
    const u = await makeUser('ages-out')
    await stream(u, 'VIEWLOOM.COM', 9.99, 11.99, TV)
    spyOnPlaid()
    await runDetectors(u.id)
    expect(await priceUp(u.id)).toHaveLength(1) // the control: it fired

    // 35 days on, the raised charge is 37 days old. Three charges are still
    // inside the analysis's 90 days, so the stream is still detected: only the
    // detector's own lookback can make the alert go away.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 35 * DAY_MS))
    await runDetectors(u.id)
    const [alert] = await priceUp(u.id)
    expect(alert.resolvedAt).not.toBeNull()
  })

  it('does not fire twice when the group\'s display name changes', async () => {
    const u = await makeUser('renamed')
    await stream(u, 'VIEWLOOM.COM', 9.99, 11.99, TV)
    spyOnPlaid()
    await runDetectors(u.id)
    expect(await priceUp(u.id)).toHaveLength(1)

    // A shorter variant arrives. Same grouping key ("viewloom"), so custom
    // detection now displays the group as "Viewloom". The latest and previous
    // charges are unchanged, so it is the same rise.
    await charge(u, 'Viewloom', 9.99, 88, TV)
    await runDetectors(u.id)
    const alerts = await priceUp(u.id)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].title).toMatch(/^Viewloom /) // the display name did change
  })

  it('builds the same fingerprint whatever the machine\'s time zone', () => {
    const now = new Date('2026-03-31T12:00:00.000Z') // already April 1 in UTC+14
    const subscription = {
      merchant: 'Viewloom', cleanMerchant: 'Viewloom', key: 'viewloom', kind: 'subscription',
      category: 'Entertainment', frequency: 'MONTHLY', lastAmount: 11.99, lastDate: '2026-03-30',
      monthlyAmount: 11.99, source: 'custom', priceChange: { previousAmount: 9.99, pctChange: 20 },
      isDuplicate: false, nextChargeDate: null, daysUntilNextCharge: null,
    }
    const analysis = { subscriptions: [subscription], bills: [], upcoming: [], alerts: [], totals: { monthlySubscriptions: 0, monthlyBills: 0, monthlyAll: 0 } }
    const ctx = { now, subscriptions: { ok: true, analysis } } as unknown as DetectorContext

    const original = process.env.TZ
    try {
      process.env.TZ = 'UTC'
      const utc = detectSubscriptionPriceUp(ctx) as Array<{ fingerprint: string }>
      process.env.TZ = 'Pacific/Kiritimati'
      const east = detectSubscriptionPriceUp(ctx) as Array<{ fingerprint: string }>
      process.env.TZ = 'America/Los_Angeles'
      const west = detectSubscriptionPriceUp(ctx) as Array<{ fingerprint: string }>
      expect(utc).toHaveLength(1) // the control: it fires at all
      expect(east.map((a) => a.fingerprint)).toEqual(utc.map((a) => a.fingerprint))
      expect(west.map((a) => a.fingerprint)).toEqual(utc.map((a) => a.fingerprint))
    } finally {
      process.env.TZ = original
    }
  })

  it('answers for nothing when its input can\'t be read: an existing alert is NOT resolved', async () => {
    const u = await makeUser('unreadable')
    const existing = await prisma.alert.create({
      data: {
        userId: u.id, kind: 'subscription_price_up', fingerprint: 'price_up:viewloom:2000-01-01',
        severity: 'medium', title: 'Viewloom raised its price', body: 'invented',
      },
    })
    failInput.on = true
    spyOnPlaid()
    await runDetectors(u.id) // must not throw: only the one detector fails

    const after = await prisma.alert.findUniqueOrThrow({ where: { id: existing.id } })
    expect(after.resolvedAt).toBeNull()
  })

  it('every merchant the bell alerts on appears in GET /subscriptions', async () => {
    const u = await makeUser('in-tab')
    await stream(u, 'VIEWLOOM.COM', 9.99, 11.99, TV)
    spyOnPlaid()
    await request(app).get('/alerts').set('X-Test-User', u.id)
    const alerts = await priceUp(u.id)
    expect(alerts.length).toBeGreaterThan(0) // the control: there is something to check

    const tab = await request(app).get('/subscriptions').set('X-Test-User', u.id)
    expect(tab.status).toBe(200)
    const inTab = new Set([...tab.body.subscriptions, ...tab.body.bills].map((s: { merchant: string }) => s.merchant))
    for (const a of alerts) expect(inTab).toContain((a.data as { merchant?: string }).merchant)
  })
})
