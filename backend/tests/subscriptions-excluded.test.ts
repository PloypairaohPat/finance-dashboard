// ─────────────────────────────────────────────────────────────────
//  tests/subscriptions-excluded.test.ts — an excluded row can't become a bill
//
//  Recurring-charge detection groups any repeating positive amount by merchant.
//  Before M7.3 that included money moved to savings and card payments, so a
//  monthly transfer could be listed as a recurring bill.
//
//  The fixture is a controlled comparison: three $250 monthly series with the
//  same amounts and the same cadence, differing only in what the classifier
//  says each one IS. The gym membership must be detected — which proves the
//  shape is detectable at all — and the other two must not. Nothing else
//  differs, so the verdict is the only thing that can account for it.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { plaidClient } from '../src/lib/plaidClient'
import { fetchSubscriptionAnalysis } from '../src/services/subscriptions.service'

/**
 * Every detected stream. Detection splits by amount: $50 and over is a "bill" and
 * goes to `bills`, not `subscriptions`. Looking in one list alone would make both
 * "not detected" assertions pass vacuously — and a monthly savings transfer is a
 * bill-sized amount, so `bills` is precisely where the bug lived.
 */
async function detectedMerchants(): Promise<string[]> {
  const analysis = await fetchSubscriptionAnalysis(USER, plaidClient)
  return [...analysis.subscriptions, ...analysis.bills].map((s) => s.merchant.toUpperCase())
}

const USER = 'subscriptions-excluded-test-user'
const BANK = 'Excluded Test Bank'
const DAY_MS = 86_400_000

async function cleanup() {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@subs-test.local` } })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER, itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`), institutionName: BANK,
    },
  })
  const account = (name: string, type: string) =>
    prisma.account.create({
      data: {
        userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-${name}`, name, type,
        subtype: type === 'credit' ? 'credit card' : 'checking',
        currentBalance: '2000.00', isoCurrencyCode: 'USD',
      },
    })
  const checking = await account('Checking', 'depository')
  // A linked card at the same bank, so a card payment to that bank is excluded (R5).
  await account('Card', 'credit')

  const today = new Date()
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const series = (
    slug: string, name: string, primary: string, detailed: string,
    counterparties: object[] = [],
  ) =>
    [10, 40, 70].map((back, i) => ({
      userId: USER, accountId: checking.id, plaidTransactionId: `${USER}-${slug}-${i}`,
      date: new Date(utcToday - back * DAY_MS), amount: '250.00', name, cleanName: name,
      categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD', pending: false,
      rawJson: { counterparties, personal_finance_category: { primary, detailed, confidence_level: 'HIGH' } },
    }))

  await prisma.transaction.createMany({
    data: [
      ...series('gym', 'IRONWORKS GYM', 'PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS',
        [{ name: 'Ironworks Gym', type: 'merchant' }]),
      ...series('savings', 'TRANSFER TO SAVINGS', 'TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'),
      ...series('card', 'CARD PAYMENT', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        [{ name: BANK, type: 'financial_institution' }]),
    ],
  })
})

afterAll(cleanup)

describe('recurring detection only considers spending', () => {
  it('detects the gym membership, proving the $250 monthly shape is detectable', async () => {
    const merchants = await detectedMerchants()
    expect(merchants.some((m) => m.includes('IRONWORKS'))).toBe(true)
  })

  it('does not list a monthly transfer to savings as a recurring bill', async () => {
    const merchants = await detectedMerchants()
    expect(merchants.some((m) => m.includes('SAVINGS'))).toBe(false)
  })

  it('does not list a monthly card payment as a recurring bill', async () => {
    const merchants = await detectedMerchants()
    expect(merchants.some((m) => m.includes('CARD PAYMENT'))).toBe(false)
  })
})
