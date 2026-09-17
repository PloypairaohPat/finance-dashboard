// ─────────────────────────────────────────────────────────────────
//  tests/digest-gross.test.ts — the weekly digest never nets payments to people
//
//  The payment-app cap is period-scoped: its floor at zero, applied to a week,
//  produces a confidently wrong figure rather than a slightly-off one. So the
//  digest reports two gross sums instead. The fixture makes the difference
//  visible: more came back this week than went out, which a floored net would
//  silently report as $0 of payments to people.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { buildWeeklyDigest } from '../src/services/alerts/digest'

const USER = 'digest-gross-test-user'

async function cleanup() {
  await prisma.alert.deleteMany({ where: { userId: USER } })
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@digest-test.local` } })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER, itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`), institutionName: `${USER}-Bank`,
    },
  })
  const account = await prisma.account.create({
    data: {
      userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-checking`,
      name: 'Checking', type: 'depository', subtype: 'checking',
      currentBalance: '1000.00', isoCurrencyCode: 'USD',
    },
  })

  const today = new Date()
  const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const venmo = [{ name: 'Venmo', type: 'payment_app' }]
  const row = (id: string, amount: string, name: string, primary: string, detailed: string, counterparties: object[] = []) => ({
    userId: USER, accountId: account.id, plaidTransactionId: `${USER}-${id}`, date: at, amount, name,
    cleanName: name, categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD',
    pending: false, rawJson: { counterparties, personal_finance_category: { primary, detailed, confidence_level: 'HIGH' } },
  })

  await prisma.transaction.createMany({
    data: [
      row('coffee', '20.00', 'BLUE BOTTLE', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'),
      row('venmo-out', '100.00', 'VENMO', 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', venmo),
      row('venmo-in', '-150.00', 'VENMO', 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', venmo),
    ],
  })
})

afterAll(cleanup)

describe('the weekly digest reports payments to people gross', () => {
  it('reports both sums, even when more came back than went out', async () => {
    const digest = await buildWeeklyDigest(USER)
    // A floored net would say max(0, 100 - 150) = $0 and hide both movements.
    expect(digest.paymentsToPeople).toEqual({ out: 100, in: 150 })
  })

  it('keeps payments to people out of ordinary spending and out of income', async () => {
    const digest = await buildWeeklyDigest(USER)
    expect(digest.spent).toBe(20)
    expect(digest.income).toBe(0)
    expect(digest.netSaved).toBe(-20)
  })

  it('says both figures in the summary the card shows', async () => {
    const digest = await buildWeeklyDigest(USER)
    expect(digest.summary).toContain('Payments to people: $100 out, $150 in.')
  })
})
