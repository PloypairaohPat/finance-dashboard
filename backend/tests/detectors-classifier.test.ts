// ─────────────────────────────────────────────────────────────────
//  tests/detectors-classifier.test.ts — alerts fire on the same figures
//  the screens show (M7.3)
//
//  Each detector used to decide for itself what counted as spending. The two
//  cases below are the ones a user would actually notice:
//
//    - paying off a credit card fired "Large purchase detected", on a
//      transaction where nothing was purchased
//    - budget alerts summed calendar months while the budget cards they refer
//      to run on money periods, so the alert and the card could disagree
//
//  The fixture user's period starts on the 10th, so a calendar month and a
//  money period are different windows and the second case is testable.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { loadContext } from '../src/services/alerts/dispatcher'
import { detectLargeTransaction } from '../src/services/alerts/detectors/largeTransaction'
import { detectBudgetExceeded } from '../src/services/alerts/detectors/budgetStatus'
import { currentPeriod, type DetectorContext } from '../src/services/alerts/types'
import { recentPeriods } from '../src/lib/period'

const USER = 'detector-classifier-test-user'
const START_DAY = 10
const DAY_MS = 86_400_000

let ctx: DetectorContext
const ids = {
  purchase: `${USER}-purchase`,
  cardPaymentOut: `${USER}-card-payment-out`,
  cardPaymentIn: `${USER}-card-payment-in`,
  transferOut: `${USER}-transfer-out`,
  transferIn: `${USER}-transfer-in`,
  lastPeriod: `${USER}-last-period`,
}

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
  await prisma.user.create({
    data: { id: USER, email: `${USER}@detector-test.local`, periodStartDay: START_DAY },
  })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER,
      itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`),
      institutionName: `${USER}-Bank`,
    },
  })
  const account = (name: string, type: string, plaidAccountId: string) =>
    prisma.account.create({
      data: {
        userId: USER, plaidItemId: item.id, plaidAccountId, name, type,
        subtype: type === 'credit' ? 'credit card' : 'checking',
        currentBalance: '1000.00', isoCurrencyCode: 'USD',
      },
    })
  const [checking, savings, card] = await Promise.all([
    account('Checking', 'depository', `${USER}-checking`),
    account('Savings', 'depository', `${USER}-savings`),
    account('Card', 'credit', `${USER}-card`),
  ])

  // Today, so everything sits inside the current period and inside the
  // 14-day window the large-transaction detector looks at.
  const today = new Date()
  const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const [previous] = recentPeriods(at, START_DAY, 2)
  const inLastPeriod = new Date(new Date(`${previous.lastDay}T00:00:00.000Z`).getTime())

  const row = (
    id: string, accountId: string, amount: string, name: string,
    primary: string, detailed: string, date: Date = at,
  ) => ({
    userId: USER, accountId, plaidTransactionId: id, date, amount, name,
    cleanName: name, categoryPrimary: primary, categoryDetailed: detailed,
    isoCurrencyCode: 'USD', pending: false,
  })

  await prisma.transaction.createMany({
    data: [
      // A real purchase: large, and genuinely spending.
      row(ids.purchase, card.id, '700.00', 'BEST BUY', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ELECTRONICS'),
      // Paying the card off: bigger, but nothing was bought.
      row(ids.cardPaymentOut, checking.id, '800.00', 'CARD PAYMENT', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
      row(ids.cardPaymentIn, card.id, '-800.00', 'PAYMENT THANK YOU', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
      // Moving money to savings: bigger still, and not spending either.
      row(ids.transferOut, checking.id, '900.00', 'TO SAVINGS', 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER'),
      row(ids.transferIn, savings.id, '-900.00', 'FROM CHECKING', 'TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER'),
      // Last period's shopping: inside this calendar month for most start days,
      // but outside the current money period.
      row(ids.lastPeriod, card.id, '500.00', 'TARGET', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES', inLastPeriod),
    ],
  })

  await prisma.budget.create({
    data: { userId: USER, category: 'Shopping', monthlyLimit: '100.00' },
  })

  ctx = await loadContext(USER)
})

afterAll(cleanup)

describe('the detector context is classified, not raw', () => {
  it('gives detectors verdicts and the money periods', () => {
    expect(ctx.startDay).toBe(START_DAY)
    expect(ctx.periods.length).toBeGreaterThan(1)
    expect(currentPeriod(ctx).inProgress).toBe(true)
    for (const row of ctx.classified) expect(row.verdict).toBeTruthy()
  })

  it('classifies the fixture the way the rules say', () => {
    const verdictFor = (merchant: string) =>
      ctx.classified.find((r) => r.merchantLabel === merchant)?.verdict
    expect(verdictFor('BEST BUY')?.kind).toBe('spend')
    expect(verdictFor('CARD PAYMENT')?.kind).toBe('card_payment')
    expect(verdictFor('TO SAVINGS')?.kind).toBe('internal_transfer')
  })
})

describe('large-transaction alerts', () => {
  it('fires on the purchase', async () => {
    const alerts = await detectLargeTransaction(ctx)
    const merchants = alerts.map((a) => (a.data as { merchant: string }).merchant)
    expect(merchants).toContain('BEST BUY')
  })

  it('does NOT fire on the card payment or the transfer, though both are larger', async () => {
    const alerts = await detectLargeTransaction(ctx)
    const merchants = alerts.map((a) => (a.data as { merchant: string }).merchant)
    expect(merchants).not.toContain('CARD PAYMENT')
    expect(merchants).not.toContain('TO SAVINGS')
    // …and not by some threshold accident: both are larger than the purchase
    // that does fire, and neither amount appears in any alert.
    const amounts = alerts.map((a) => (a.data as { amount: number }).amount)
    expect(amounts).not.toContain(800)
    expect(amounts).not.toContain(900)
    // This detector looks back 14 days rather than by period, so last period's
    // $500 purchase legitimately fires too — it is spending either way.
    expect(amounts.every((a) => a === 700 || a === 500)).toBe(true)
  })
})

describe('budget alerts use the money period, like the cards they refer to', () => {
  it('counts only this period, and only real spending', async () => {
    const alerts = await detectBudgetExceeded(ctx)
    expect(alerts).toHaveLength(1)
    const data = alerts[0].data as { category: string; period: string; spent: number }
    expect(data.category).toBe('Shopping')
    // $700 this period. Last period's $500 is excluded, and so is the $800 card
    // payment, which the old detector would have counted under Debt.
    expect(data.spent).toBe(700)
    expect(data.period).toBe(currentPeriod(ctx).key)
  })

  it('keys the alert to the period, not a calendar month', async () => {
    const [alert] = await detectBudgetExceeded(ctx)
    expect(alert.fingerprint).toBe(`budget_exceeded:Shopping:${currentPeriod(ctx).key}`)
    expect(alert.fingerprint).not.toMatch(/\d{4}-\d{2}$/) // not a YYYY-MM key
  })
})
