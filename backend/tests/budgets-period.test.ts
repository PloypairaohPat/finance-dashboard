// ─────────────────────────────────────────────────────────────────
//  tests/budgets-period.test.ts — budgets run on money periods (M7.3)
//
//  The demo seed cannot prove this: it uses start day 1, where a calendar month
//  and a money period are the same window, so the change is invisible there.
//  This user starts their period on the 10th, which makes the two windows
//  disagree and the move testable.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { fromDateKey, recentPeriods } from '../src/lib/period'
import { fetchBudgetsWithSpend } from '../src/services/budgets.service'

const USER = 'budget-period-test-user'
const START_DAY = 10
const DAY_MS = 86_400_000

let currentPeriodKey: string
let onBoundary: Date
let beforeBoundary: Date

async function cleanup() {
  await prisma.budget.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({
    data: { id: USER, email: `${USER}@budget-test.local`, periodStartDay: START_DAY },
  })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER,
      itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`),
      institutionName: `${USER}-Bank`,
    },
  })
  const account = await prisma.account.create({
    data: {
      userId: USER,
      plaidItemId: item.id,
      plaidAccountId: `${USER}-acct`,
      name: 'Checking',
      type: 'depository',
      subtype: 'checking',
      currentBalance: '5000.00',
      isoCurrencyCode: 'USD',
    },
  })

  const [, current] = recentPeriods(new Date(), START_DAY, 2)
  currentPeriodKey = current.key
  onBoundary = fromDateKey(current.start)
  beforeBoundary = new Date(onBoundary.getTime() - DAY_MS)

  await prisma.transaction.createMany({
    data: [
      // The day before the period starts: last period's spending.
      {
        userId: USER, accountId: account.id, plaidTransactionId: `${USER}-prev`,
        date: beforeBoundary, amount: '100.00', name: 'TARGET',
        categoryPrimary: 'GENERAL_MERCHANDISE', categoryDetailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
        isoCurrencyCode: 'USD', pending: false,
      },
      // The first day of the current period.
      {
        userId: USER, accountId: account.id, plaidTransactionId: `${USER}-current`,
        date: onBoundary, amount: '40.00', name: 'TARGET',
        categoryPrimary: 'GENERAL_MERCHANDISE', categoryDetailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
        isoCurrencyCode: 'USD', pending: false,
      },
    ],
  })

  await prisma.budget.create({
    data: { userId: USER, category: 'Shopping', monthlyLimit: '500.00' },
  })
})

afterAll(cleanup)

describe('budgets cover the money period, not the calendar month', () => {
  it('counts only spending inside the current period', async () => {
    const res = await request(app).get('/budgets').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    const [budget] = res.body.budgets as Array<{ category: string; currentSpend: number; month: string }>
    expect(budget.category).toBe('Shopping')
    // $40 on the boundary day counts; $100 the day before belongs to last period.
    expect(budget.currentSpend).toBe(40)
  })

  it('reports the window it used as the period key, and the start day', async () => {
    const res = await request(app).get('/budgets').set('X-Test-User', USER)
    expect(res.body.periodStartDay).toBe(START_DAY)
    expect(res.body.budgets[0].month).toBe(currentPeriodKey)
  })

  it('asking for the previous period returns that period, not this one', async () => {
    const [previous] = recentPeriods(new Date(), START_DAY, 2)
    const [budget] = await fetchBudgetsWithSpend(USER, previous.key, START_DAY)
    // The $100 the day before the boundary belongs to the previous period, and
    // asking for that period is how you see it.
    expect(budget.currentSpend).toBe(100)
    expect(budget.month).toBe(previous.key)
    expect(beforeBoundary.getTime()).toBeLessThan(onBoundary.getTime())
  })

  it('paces the projection against the period, not the calendar month', async () => {
    const [budget] = await fetchBudgetsWithSpend(USER, undefined, START_DAY)
    const [, current] = recentPeriods(new Date(), START_DAY, 2)
    if (current.inProgress && current.dayOfPeriod >= 7) {
      const expected = Math.round(((40 / current.dayOfPeriod) * current.daysInPeriod) * 100) / 100
      expect(budget.projected).toBe(expected)
    } else {
      expect(budget.projected).toBeNull()
    }
  })
})
