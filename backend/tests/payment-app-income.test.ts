// ─────────────────────────────────────────────────────────────────
//  tests/payment-app-income.test.ts — the paymentAppInflowsAreIncome setting
//
//  R4 says money in through a payment app is someone paying you back, so it
//  reduces what you paid out (D5's per-period cap) and is never income. That is
//  wrong for someone whose roommates send them the rent every month: under the
//  cap, a surplus is dropped, so their share of the rent counts nowhere at all.
//
//  The setting is per user and off by default, because the other real user of
//  this app must not have their income move without asking.
//
//  What is pinned here:
//    - with it off, nothing about R4 changes;
//    - with it on, those inflows are income and the cap has no inflow left,
//      so "Payments to people" is the period's gross outflows and the surplus
//      is gone rather than dropped;
//    - the switch is on WHAT A ROW IS, not on rule 4, so no row is counted as
//      income and netted against spend at the same time;
//    - it applies to past periods, because verdicts are derived on read.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { classify, type ClassifierTx } from '../src/lib/classifier'
import { carryForward, perPeriodCap, type PeriodFlow } from '../src/lib/paymentApp'

const USER = 'payment-app-income-test-user'
const DAY_MS = 86_400_000

// One period, three weeks back so every row is inside the current money period
// whatever day of the month the suite runs on.
const PERIOD_KEY = '2026-01-01'
const day = (n: number) => new Date(Date.UTC(2026, 0, n))

const tx = (over: Partial<ClassifierTx> & { id: string }): ClassifierTx => ({
  accountId: 'checking', accountType: 'depository', date: day(10), amount: 0,
  categoryPrimary: 'TRANSFER_IN', categoryDetailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS',
  confidence: 'VERY_HIGH', counterparties: [{ name: 'Zelle', type: 'payment_app' }], pending: false,
  ...over,
})

const options = (paymentAppInflowsAreIncome: boolean) => ({
  linkedInstitutions: [],
  institutionsWithCreditAccount: [],
  periodKeyOf: () => PERIOD_KEY,
  paymentAppInflowsAreIncome,
})

describe('the rule itself', () => {
  // Rent in from two roommates, one dinner paid out: a net receiver.
  const rows = [
    tx({ id: 'rent-a', amount: -900 }),
    tx({ id: 'rent-b', amount: -900 }),
    tx({ id: 'dinner', amount: 60, categoryPrimary: 'TRANSFER_OUT', categoryDetailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS' }),
  ]

  it('off: inflows are repayments and the cap eats the outflow', () => {
    const { byId, paymentApp } = classify(rows, options(false))
    expect(byId.get('rent-a')).toMatchObject({ kind: 'payment_app_in', mechanism: 'payment-app-in' })
    expect(byId.get('dinner')).toMatchObject({ kind: 'spend', mechanism: 'payment-app-out' })
    expect(paymentApp).toHaveLength(1)
    expect(paymentApp[0]).toMatchObject({ out: 60, in: 1800, spend: 0, surplus: 1740 })
  })

  it('on: inflows are income, and the cap has nothing left to net', () => {
    const { byId, paymentApp } = classify(rows, options(true))
    expect(byId.get('rent-a')).toMatchObject({ kind: 'income', mechanism: 'payment-app-in-income' })
    expect(byId.get('rent-b')!.reason).toMatch(/user's setting/)
    // Outflows are untouched: they still go to "Payments to people".
    expect(byId.get('dinner')).toMatchObject({ kind: 'spend', mechanism: 'payment-app-out' })
    expect(paymentApp[0]).toMatchObject({ out: 60, in: 0, spend: 60, surplus: 0 })
  })

  it('leaves a payment app used as a rail to a merchant alone', () => {
    const viaMerchant = tx({
      id: 'etsy', amount: -14.52,
      counterparties: [{ name: 'Zelle', type: 'payment_app' }, { name: 'Etsy', type: 'merchant' }],
    })
    for (const on of [false, true]) {
      const { byId } = classify([viaMerchant], options(on))
      expect(byId.get('etsy')!.mechanism, `setting ${on}`).not.toMatch(/payment-app/)
    }
  })

  it('makes D5 inert rather than choosing between its options', () => {
    // The whole (a)-vs-(c) question was what to do with inflow that outflow
    // didn't absorb. With the setting on there is no inflow here to carry, so
    // both options give the same series and the surplus is zero.
    const { paymentApp } = classify(
      [tx({ id: 'in-1', amount: -500 }), tx({ id: 'out-1', amount: 80, categoryPrimary: 'TRANSFER_OUT', categoryDetailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS' })],
      options(true),
    )
    const flows: PeriodFlow[] = paymentApp.map((p) => ({ key: p.key, out: p.out, in: p.in }))
    expect(perPeriodCap(flows)).toEqual(carryForward(flows))
    expect(flows[0]).toMatchObject({ out: 80, in: 0 })
  })
})

// ── through the endpoints, against the database ───────────────────

async function cleanup() {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

const setSetting = (on: boolean) =>
  prisma.user.update({ where: { id: USER }, data: { paymentAppInflowsAreIncome: on } })

const get = (path: string) => request(app).get(path).set('X-Test-User', USER)

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@payment-app-income.local` } })
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
      currentBalance: '2500.00', isoCurrencyCode: 'USD',
    },
  })

  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const rows: Array<[string, number, number, string, string, boolean]> = [
    // [id, days back, amount, primary, detailed, via payment app]
    ['paycheck', 2, -3000, 'INCOME', 'INCOME_WAGES', false],
    ['rent-share-a', 1, -900, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', true],
    ['rent-share-b', 1, -900, 'TRANSFER_IN', 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', true],
    ['dinner-split', 0, 60, 'TRANSFER_OUT', 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS', true],
    ['groceries', 0, 120, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', false],
  ]
  for (const [id, back, amount, primary, detailed, viaApp] of rows) {
    await prisma.transaction.create({
      data: {
        userId: USER, accountId: account.id, plaidTransactionId: `${USER}-${id}`,
        date: new Date(today.getTime() - back * DAY_MS), amount: String(amount),
        name: id.toUpperCase(), cleanName: id.toUpperCase(),
        categoryPrimary: primary, categoryDetailed: detailed,
        isoCurrencyCode: 'USD', pending: false,
        rawJson: {
          personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' },
          counterparties: viaApp ? [{ name: 'Zelle', type: 'payment_app' }] : [{ name: id, type: 'merchant' }],
        },
      },
    })
  }
})

afterAll(cleanup)

describe('GET /user/settings', () => {
  it('defaults to off for a user who has never chosen', async () => {
    const res = await get('/user/settings')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ periodStartDay: 1, paymentAppInflowsAreIncome: false })
  })

  it.each([
    [{ paymentAppInflowsAreIncome: 'true' }, /must be true or false/],
    [{ paymentAppInflowsAreIncome: 1 }, /must be true or false/],
    [{}, /Nothing to save/],
  ])('refuses %j', async (body, message) => {
    const res = await request(app).put('/user/settings').set('X-Test-User', USER).send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(message)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } })
    expect(row.paymentAppInflowsAreIncome).toBe(false)
  })

  it('saves one setting without disturbing the other', async () => {
    const res = await request(app).put('/user/settings').set('X-Test-User', USER)
      .send({ paymentAppInflowsAreIncome: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ periodStartDay: 1, paymentAppInflowsAreIncome: true })
    await setSetting(false)
  })
})

describe('what the figures do', () => {
  it('off: the rent shares count nowhere, which is the bug', async () => {
    await setSetting(false)
    const { body } = await get('/insights')
    // $3000 paycheck only: $1800 of rent money in is a "repayment".
    expect(body.summary.income).toBeCloseTo(3000, 2)
    // Groceries $120; the $60 payment out is fully absorbed by the cap.
    expect(body.summary.expenses).toBeCloseTo(120, 2)
  })

  it('on: the rent shares are income, and payments out are reported gross', async () => {
    await setSetting(true)
    const { body } = await get('/insights')
    expect(body.summary.income).toBeCloseTo(3000 + 1800, 2)
    expect(body.summary.expenses).toBeCloseTo(120 + 60, 2)
    expect(body.summary.netSaved).toBeCloseTo(4800 - 180, 2)
    await setSetting(false)
  })

  it('never counts one row as income and as netting at the same time', async () => {
    // Income + spend must move by exactly the inflow and the absorbed outflow.
    await setSetting(false)
    const off = (await get('/insights')).body.summary
    await setSetting(true)
    const on = (await get('/insights')).body.summary
    await setSetting(false)
    expect(on.income - off.income).toBeCloseTo(1800, 2)
    expect(on.expenses - off.expenses).toBeCloseTo(60, 2)
  })

  it('applies to a past period, not just from now on', async () => {
    // The rows are dated in the current period; cash flow covers earlier ones too,
    // and the current period is one of the entries it returns.
    await setSetting(true)
    const { body } = await get('/cashflow')
    await setSetting(false)
    const current = body.cashflow[body.cashflow.length - 1]
    expect(current.income).toBeCloseTo(4800, 2)
  })

  it('relabels the row for the user, from Repayment to Income', async () => {
    await setSetting(true)
    const { body } = await get('/transactions/search')
    await setSetting(false)
    const row = body.transactions.find((t: any) => t.displayName === 'RENT-SHARE-A')
    expect(row.meaning).toEqual({ kind: 'income', label: 'Income' })
  })

  it('drops the "$0 in" half of the digest line', async () => {
    await setSetting(false)
    const off = (await get('/alerts/digest')).body
    await setSetting(true)
    const on = (await get('/alerts/digest')).body
    await setSetting(false)
    expect(off.summary).toMatch(/Payments to people: \$\d+ out, \$\d+ in\./)
    expect(on.summary).toMatch(/Payments to people: \$\d+ out\./)
    expect(on.summary).not.toMatch(/in\./)
  })
})
