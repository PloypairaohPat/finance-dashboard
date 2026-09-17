// ─────────────────────────────────────────────────────────────────
//  tests/verdict-override.test.ts — the user's own answer about a row
//
//  Scoped deliberately. On the real account, 125 payment-app inflows totalling
//  $39,374.54 were measured: 4 rows ($504) are the user's own money coming back
//  and the rest are genuinely from other people. So this is an edge-case tool
//  for those 4 rows, not a general "make this row anything" mechanism — every
//  other verdict is decided by structure (a matched pair, a card payment, a
//  category) and belongs to the rules.
//
//  Pinned here:
//    - both directions, and clearing it;
//    - it is applied AFTER the rules, so it never changes another row;
//    - it is applied BEFORE the cap, so an overridden row nets the way the user
//      said;
//    - it stores a target, not a flip, so the income setting can't invert it;
//    - anything the rules decide structurally is refused;
//    - a Plaid sync of the same transaction doesn't wipe it.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { classify, type ClassifierTx } from '../src/lib/classifier'

const USER = 'verdict-override-test-user'
const DAY_MS = 86_400_000
const ids: Record<string, string> = {}

const tx = (over: Partial<ClassifierTx> & { id: string }): ClassifierTx => ({
  accountId: 'checking', accountType: 'depository', date: new Date(Date.UTC(2026, 0, 10)), amount: -100,
  categoryPrimary: 'TRANSFER_IN', categoryDetailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS',
  confidence: 'VERY_HIGH', counterparties: [{ name: 'Venmo', type: 'payment_app' }], pending: false,
  ...over,
})
const options = (paymentAppInflowsAreIncome: boolean) => ({
  linkedInstitutions: [], institutionsWithCreditAccount: [],
  periodKeyOf: () => '2026-01-01', paymentAppInflowsAreIncome,
})

describe('the override in the classifier', () => {
  it('stores a target, so the income setting cannot invert what the user said', () => {
    const rows = [
      tx({ id: 'says-income', verdictOverride: 'income' }),
      tx({ id: 'says-repayment', verdictOverride: 'repayment' }),
    ]
    for (const setting of [false, true]) {
      const { byId } = classify(rows, options(setting))
      expect(byId.get('says-income')!.kind, `setting ${setting}`).toBe('income')
      expect(byId.get('says-repayment')!.kind, `setting ${setting}`).toBe('payment_app_in')
    }
  })

  it('keeps what the rules said, so the panel can show it and offer a way back', () => {
    const { byId } = classify([tx({ id: 'a', verdictOverride: 'income' })], options(false))
    expect(byId.get('a')!.overriddenFrom).toEqual({ kind: 'payment_app_in', mechanism: 'payment-app-in' })
    expect(byId.get('a')!.reason).toMatch(/because the user said so/)
  })

  it('nets against payments to people when the user says repayment, and not when income', () => {
    const rows = [
      tx({ id: 'out', amount: 300, categoryPrimary: 'TRANSFER_OUT', categoryDetailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS' }),
      tx({ id: 'in', amount: -100, verdictOverride: 'repayment' }),
    ]
    // Setting on: this inflow would have been income, but the user said otherwise.
    expect(classify(rows, options(true)).paymentApp[0]).toMatchObject({ out: 300, in: 100, spend: 200 })
    // And the other way: setting off, but the user says this one was income.
    const asIncome = [rows[0], tx({ id: 'in', amount: -100, verdictOverride: 'income' })]
    expect(classify(asIncome, options(false)).paymentApp[0]).toMatchObject({ out: 300, in: 0, spend: 300 })
  })

  it('never changes another row: a card-payment pair is untouched', () => {
    const pair = [
      tx({ id: 'card-out', amount: 812.34, accountType: 'depository', categoryPrimary: 'LOAN_PAYMENTS', categoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', counterparties: [] }),
      tx({ id: 'card-in', amount: -812.34, accountId: 'card', accountType: 'credit', categoryPrimary: 'LOAN_PAYMENTS', categoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', counterparties: [], date: new Date(Date.UTC(2026, 0, 12)) }),
      tx({ id: 'venmo-in', verdictOverride: 'income' }),
    ]
    const { byId } = classify(pair, options(false))
    expect(byId.get('card-out')!.kind).toBe('card_payment')
    expect(byId.get('card-in')!.kind).toBe('card_payment')
    expect(byId.get('venmo-in')!.kind).toBe('income')
  })

  it('ignores an override on a row the rules decide structurally', () => {
    const notEligible = tx({
      id: 'groceries', amount: 42, categoryPrimary: 'FOOD_AND_DRINK', categoryDetailed: 'FOOD_AND_DRINK_GROCERIES',
      counterparties: [{ name: 'Whole Foods', type: 'merchant' }], verdictOverride: 'income',
    })
    expect(classify([notEligible], options(false)).byId.get('groceries')!.kind).toBe('spend')
  })

  it('ignores one on a pending row, whose id changes when it posts', () => {
    const { byId } = classify([tx({ id: 'p', pending: true, verdictOverride: 'income' })], options(false))
    expect(byId.get('p')!.kind).toBe('payment_app_in')
  })
})

// ── through the API ───────────────────────────────────────────────

async function cleanup() {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

const patch = (name: string, body: object) =>
  request(app).patch(`/transactions/${ids[name]}`).set('X-Test-User', USER).send(body)
const stored = (name: string) => prisma.transaction.findUniqueOrThrow({ where: { id: ids[name] } })
const insights = () => request(app).get('/insights').set('X-Test-User', USER)

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@override-test.local` } })
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
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const rows: Array<[string, number, number, string, string, boolean, boolean]> = [
    // [id, days back, amount, primary, detailed, via payment app, pending]
    ['cashout', 1, -504, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', true, false],
    ['rent-share', 1, -900, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', true, false],
    ['pending-in', 0, -25, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', true, true],
    ['groceries', 0, 120, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', false, false],
    ['paycheck', 2, -3000, 'INCOME', 'INCOME_WAGES', false, false],
  ]
  for (const [id, back, amount, primary, detailed, viaApp, pending] of rows) {
    const created = await prisma.transaction.create({
      data: {
        userId: USER, accountId: account.id, plaidTransactionId: `${USER}-${id}`,
        date: new Date(today.getTime() - back * DAY_MS), amount: String(amount),
        name: id.toUpperCase(), cleanName: id.toUpperCase(),
        categoryPrimary: primary, categoryDetailed: detailed, pending,
        isoCurrencyCode: 'USD',
        rawJson: {
          personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' },
          counterparties: viaApp ? [{ name: 'Venmo', type: 'payment_app' }] : [{ name: id, type: 'merchant' }],
        },
      },
    })
    ids[id] = created.id
  }
  // The account has the setting on: payment-app money in is income by default.
  await prisma.user.update({ where: { id: USER }, data: { paymentAppInflowsAreIncome: true } })
})

afterAll(cleanup)

describe('PATCH /transactions/:id verdictOverride', () => {
  it('takes a cash-out out of income, and puts it back when cleared', async () => {
    // The pending $25 inflow counts too: pending rows count everywhere (M7.3).
    const before = (await insights()).body.summary.income
    expect(before).toBeCloseTo(3000 + 504 + 900 + 25, 2)

    const res = await patch('cashout', { verdictOverride: 'repayment' })
    expect(res.status).toBe(200)
    expect(res.body.transaction).toMatchObject({
      verdictOverride: 'repayment',
      verdictOverridable: true,
      meaning: { kind: 'payment_app_in', label: 'Repayment' },
      verdictBeforeOverride: { kind: 'income', label: 'Income' },
    })
    expect((await stored('cashout')).verdictOverrideAt).toBeInstanceOf(Date)
    expect((await insights()).body.summary.income).toBeCloseTo(3000 + 900 + 25, 2)

    const cleared = await patch('cashout', { verdictOverride: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.transaction).toMatchObject({ verdictOverride: null, verdictBeforeOverride: null })
    expect((await stored('cashout')).verdictOverrideAt).toBeNull()
    expect((await insights()).body.summary.income).toBeCloseTo(before, 2)
  })

  it.each([['nope'], [42], [true], ['spend']])('refuses %j with 400', async (value) => {
    const res = await patch('rent-share', { verdictOverride: value })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown verdictOverride/)
    expect((await stored('rent-share')).verdictOverride).toBeNull()
  })

  it.each([
    ['groceries', /rules decide from its own structure/],
    ['paycheck', /rules decide from its own structure/],
    ['pending-in', /still pending/],
  ])('refuses to override %s with 409', async (name, message) => {
    const res = await patch(name, { verdictOverride: 'repayment' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(message)
    expect((await stored(name)).verdictOverride).toBeNull()
  })

  it('marks which rows the panel may offer it for', async () => {
    const { body } = await request(app).get('/transactions/search').set('X-Test-User', USER)
    const by = new Map(
      (body.transactions as Array<{ displayName: string; verdictOverridable: boolean }>)
        .map((t) => [t.displayName, t.verdictOverridable]),
    )
    expect(by.get('CASHOUT')).toBe(true)
    expect(by.get('RENT-SHARE')).toBe(true)
    expect(by.get('GROCERIES')).toBe(false)
    expect(by.get('PAYCHECK')).toBe(false)
    expect(by.get('PENDING-IN')).toBe(false)
  })

  it('survives a Plaid sync of the same transaction', async () => {
    await patch('cashout', { verdictOverride: 'repayment' })
    // What plaidSync writes for a MODIFIED transaction, field for field.
    await prisma.transaction.updateMany({
      where: { plaidTransactionId: `${USER}-cashout` },
      data: {
        pending: false, amount: '-504', merchantName: 'Venmo',
        categoryPrimary: 'TRANSFER_IN', categoryDetailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS',
      },
    })
    expect((await stored('cashout')).verdictOverride).toBe('repayment')
    await patch('cashout', { verdictOverride: null })
  })
})
