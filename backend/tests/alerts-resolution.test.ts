// ─────────────────────────────────────────────────────────────────
//  tests/alerts-resolution.test.ts — alerts clear themselves (M7.3)
//
//  Until now nothing ever set an alert down. A detector fired, the row stayed
//  active until the user dismissed it, and the bell counted conditions that had
//  stopped being true weeks earlier ("91 active" in plan §7).
//
//  The four rules this pins:
//    1. a condition that stops being true resolves itself
//    2. dismissed-and-still-true stays dismissed (the M7.1 behaviour)
//    3. dismissed → resolved → true again comes BACK, undismissed
//    4. an alert whose owner did not run, or has no owner, is never resolved
//       by absence
//  …plus the hysteresis band that stops a budget projection flickering.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { runDetectors, fetchActiveAlerts } from '../src/services/alerts/dispatcher'
import { recentPeriods } from '../src/lib/period'

const USER = 'alert-resolution-test-user'
const LIMIT = 100
const TX_ID = `${USER}-shopping`

let accountId: string
let startDay: number
let dayOfPeriod: number
let daysInPeriod: number
let periodKey: string

/**
 * Pick a start day that puts "today" in the early-middle of the period.
 *
 * Two constraints pull against each other: pace is only computed from day 7, and
 * "projected over" only applies while spending is still UNDER the limit. Late in
 * a period, projecting 1.3x the limit needs spend above the limit, which is a
 * different alert. Anywhere under ~60% through the period satisfies both.
 */
function chooseStartDay(now: Date): number {
  for (let candidate = 1; candidate <= 28; candidate++) {
    const [p] = recentPeriods(now, candidate, 1)
    if (p.dayOfPeriod >= 8 && p.dayOfPeriod <= p.daysInPeriod * 0.6) return candidate
  }
  throw new Error('no start day puts today in the early-middle of a period')
}

async function setShoppingSpend(amount: number) {
  const today = new Date()
  const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  await prisma.transaction.upsert({
    where: { plaidTransactionId: TX_ID },
    create: {
      userId: USER, accountId, plaidTransactionId: TX_ID, date: at,
      amount: amount.toFixed(2), name: 'TARGET', cleanName: 'TARGET',
      categoryPrimary: 'GENERAL_MERCHANDISE', categoryDetailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
      isoCurrencyCode: 'USD', pending: false,
    },
    update: { amount: amount.toFixed(2), deletedAt: null },
  })
}

/** The spend that makes the projection land on a chosen figure. */
const spendForProjection = (projected: number) => (projected * dayOfPeriod) / daysInPeriod

const findAlert = (fingerprint: string) =>
  prisma.alert.findFirst({ where: { userId: USER, fingerprint } })

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.budget.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  const now = new Date()
  startDay = chooseStartDay(now)
  const [period] = recentPeriods(now, startDay, 1)
  dayOfPeriod = period.dayOfPeriod
  daysInPeriod = period.daysInPeriod
  periodKey = period.key

  await prisma.user.create({
    data: { id: USER, email: `${USER}@alert-test.local`, periodStartDay: startDay },
  })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER, itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`), institutionName: `${USER}-Bank`,
    },
  })
  const account = await prisma.account.create({
    data: {
      userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-card`,
      name: 'Card', type: 'credit', subtype: 'credit card',
      currentBalance: '500.00', isoCurrencyCode: 'USD',
    },
  })
  accountId = account.id
  await prisma.budget.create({
    data: { userId: USER, category: 'Shopping', monthlyLimit: LIMIT.toFixed(2) },
  })
})

afterAll(cleanup)

const EXCEEDED = () => `budget_exceeded:Shopping:${periodKey}`
const PROJECTED = () => `budget_proj:Shopping:${periodKey}`

describe('a condition that stops being true resolves itself', () => {
  beforeEach(async () => {
    await prisma.alert.deleteMany({ where: { userId: USER } })
  })

  it('resolves the alert and drops it from the bell', async () => {
    await setShoppingSpend(LIMIT + 50)
    await runDetectors(USER)
    expect((await findAlert(EXCEEDED()))?.resolvedAt).toBeNull()
    expect((await fetchActiveAlerts(USER)).map((a) => a.fingerprint)).toContain(EXCEEDED())

    // A refund lands and the category is back under its limit.
    await setShoppingSpend(10)
    await runDetectors(USER)

    const after = await findAlert(EXCEEDED())
    expect(after?.resolvedAt).toBeInstanceOf(Date)
    expect((await fetchActiveAlerts(USER)).map((a) => a.fingerprint)).not.toContain(EXCEEDED())
  })

  it('leaves an alert nobody owns alone, rather than resolving it by absence', async () => {
    // The demo seed carries kinds no detector emits. Absence must not clear them:
    // no detector answered for that kind, so nothing has said it is untrue.
    await prisma.alert.create({
      data: {
        userId: USER, kind: 'budget_pace', fingerprint: `${USER}-orphan`,
        severity: 'medium', title: 'Seeded alert', body: 'No detector owns this kind.',
      },
    })
    await setShoppingSpend(10)
    await runDetectors(USER)

    const orphan = await findAlert(`${USER}-orphan`)
    expect(orphan?.resolvedAt).toBeNull()
  })
})

describe('dismissal and resolution are different things', () => {
  beforeEach(async () => {
    await prisma.alert.deleteMany({ where: { userId: USER } })
  })

  it('a dismissed alert whose condition still holds stays dismissed and unresolved', async () => {
    await setShoppingSpend(LIMIT + 50)
    await runDetectors(USER)
    await prisma.alert.updateMany({
      where: { userId: USER, fingerprint: EXCEEDED() },
      data: { dismissedAt: new Date() },
    })

    await runDetectors(USER) // condition unchanged

    const alert = await findAlert(EXCEEDED())
    expect(alert?.dismissedAt).toBeInstanceOf(Date)
    expect(alert?.resolvedAt).toBeNull()
    expect((await fetchActiveAlerts(USER)).map((a) => a.fingerprint)).not.toContain(EXCEEDED())
  })

  it('dismissed, then resolved, then true again: it comes back undismissed', async () => {
    await setShoppingSpend(LIMIT + 50)
    await runDetectors(USER)
    await prisma.alert.updateMany({
      where: { userId: USER, fingerprint: EXCEEDED() },
      data: { dismissedAt: new Date() },
    })

    // Fixed…
    await setShoppingSpend(10)
    await runDetectors(USER)
    expect((await findAlert(EXCEEDED()))?.resolvedAt).toBeInstanceOf(Date)

    // …and blown again in the same period.
    await setShoppingSpend(LIMIT + 80)
    await runDetectors(USER)

    const alert = await findAlert(EXCEEDED())
    expect(alert?.resolvedAt).toBeNull()
    expect(alert?.dismissedAt).toBeNull() // the old dismissal does not silence a new occurrence
    expect((await fetchActiveAlerts(USER)).map((a) => a.fingerprint)).toContain(EXCEEDED())
  })
})

describe('the budget projection holds until it is clearly under', () => {
  beforeEach(async () => {
    await prisma.alert.deleteMany({ where: { userId: USER } })
  })

  it('fires above the limit, holds through a small dip, and resolves below the band', async () => {
    // Over the limit on pace, but not yet over in absolute terms.
    await setShoppingSpend(spendForProjection(LIMIT * 1.3))
    await runDetectors(USER)
    expect((await findAlert(PROJECTED()))?.resolvedAt).toBeNull()

    // Dips 8% under the limit — inside the 15% band, so it keeps standing
    // rather than clearing and re-firing tomorrow.
    await setShoppingSpend(spendForProjection(LIMIT * 0.92))
    await runDetectors(USER)
    expect((await findAlert(PROJECTED()))?.resolvedAt).toBeNull()

    // Clearly under: resolved.
    await setShoppingSpend(spendForProjection(LIMIT * 0.8))
    await runDetectors(USER)
    expect((await findAlert(PROJECTED()))?.resolvedAt).toBeInstanceOf(Date)
  })
})
