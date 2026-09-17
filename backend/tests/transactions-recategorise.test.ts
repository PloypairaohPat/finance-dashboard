// ─────────────────────────────────────────────────────────────────
//  tests/transactions-recategorise.test.ts — changing a row's category
//
//  The detail panel offers DISPLAY categories ("Shopping"), and PATCH used to write
//  that name straight into categoryPrimary, where Plaid codes live. Every total
//  maps the stored value back through mapPlaidCategory, which matches no prefix in
//  "Shopping" — so a purchase moved to Shopping was counted under Other, and
//  moving a transfer overwrote the TRANSFER_* code R2 pairs on.
//
//  Pinned here: a chosen category round-trips into the totals, unknown names are
//  refused, and a row whose category decides nothing cannot be recategorised.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import {
  ASSIGNABLE_CATEGORIES, ASSIGNABLE_CATEGORY_CODES, DISPLAY_CATEGORIES, mapPlaidCategory,
} from '../src/lib/categoryMap'
import { LINKED_BANK_ALLOWLIST, SAVINGS_EXCLUSION_CODES, canRecategorise } from '../src/lib/classifier'

const USER = 'transactions-recategorise-test-user'
const OTHER_USER = 'transactions-recategorise-other-user'
const DAY_MS = 86_400_000

const ids: Record<string, string> = {}

async function cleanup() {
  for (const u of [USER, OTHER_USER]) {
    await prisma.transaction.deleteMany({ where: { userId: u } })
    await prisma.account.deleteMany({ where: { userId: u } })
    await prisma.plaidItem.deleteMany({ where: { userId: u } })
    await prisma.user.deleteMany({ where: { id: u } })
  }
}

const patch = (name: string, body: object, user = USER) =>
  request(app).patch(`/transactions/${ids[name]}`).set('X-Test-User', user).send(body)

const stored = (name: string) =>
  prisma.transaction.findUniqueOrThrow({ where: { id: ids[name] } })

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@recategorise-test.local` } })
  await prisma.user.create({ data: { id: OTHER_USER, email: `${OTHER_USER}@recategorise-test.local` } })
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER, itemId: `${USER}-item`,
      accessToken: encrypt(`fake-token-${USER}`), institutionName: `${USER}-Bank`,
    },
  })
  const account = (name: string, type: string) =>
    prisma.account.create({
      data: {
        userId: USER, plaidItemId: item.id, plaidAccountId: `${USER}-${name}`, name, type,
        subtype: type === 'credit' ? 'credit card' : 'checking',
        currentBalance: '1000.00', isoCurrencyCode: 'USD',
      },
    })
  const [checking, savings, card] = [
    await account('Checking', 'depository'),
    await account('Savings', 'depository'),
    await account('Card', 'credit'),
  ]

  // Everything dated today, so it all sits in the current money period that
  // GET /transactions/categories reports.
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const rows: Array<[string, string, string, string, string]> = [
    ['lunch', card.id, '42.17', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'],
    ['looper', card.id, '13.03', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'],
    ['pay-out', checking.id, '812.34', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
    ['pay-in', card.id, '-812.34', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
    ['xfer-out', checking.id, '300.00', 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER'],
    ['xfer-in', savings.id, '-300.00', 'TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER'],
  ]
  for (const [name, accountId, amount, primary, detailed] of rows) {
    const created = await prisma.transaction.create({
      data: {
        userId: USER, accountId, plaidTransactionId: `${USER}-${name}`, date: today, amount,
        name: name.toUpperCase(), cleanName: name.toUpperCase(),
        categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD', pending: false,
        rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'VERY_HIGH' } },
      },
    })
    ids[name] = created.id
  }
})

afterAll(cleanup)

describe('the display-category → Plaid-code mapping', () => {
  it('maps every assignable category back to itself through both codes', () => {
    for (const category of ASSIGNABLE_CATEGORIES) {
      const { primary, detailed } = ASSIGNABLE_CATEGORY_CODES[category]
      expect(mapPlaidCategory(primary)).toBe(category)
      expect(mapPlaidCategory(detailed)).toBe(category)
      if (primary !== null) expect(detailed?.startsWith(`${primary}_`)).toBe(true)
    }
  })

  it('writes no code any rule treats as a transfer, card payment, savings or income', () => {
    const signals = new Set<string>([...LINKED_BANK_ALLOWLIST, ...SAVINGS_EXCLUSION_CODES, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'])
    for (const category of ASSIGNABLE_CATEGORIES) {
      const { primary, detailed } = ASSIGNABLE_CATEGORY_CODES[category]
      expect(signals.has(detailed ?? '')).toBe(false)
      expect(`${primary ?? ''} ${detailed ?? ''}`).not.toMatch(/TRANSFER_|INCOME/)
    }
  })

  it('offers every display category a row can land in, and only those', () => {
    // Subscriptions is the one display category no Plaid code maps to.
    expect([...ASSIGNABLE_CATEGORIES]).toEqual(DISPLAY_CATEGORIES.filter((c) => c !== 'Subscriptions'))
  })

  it('allows edits only where the category decides the bucket', () => {
    expect(canRecategorise({ rule: 7, mechanism: 'ordinary-spend' }, 'FOOD_AND_DRINK_COFFEE')).toBe(true)
    expect(canRecategorise({ rule: 3, mechanism: 'refund' }, 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')).toBe(true)
    expect(canRecategorise({ rule: 3, mechanism: 'refund-unallocated' }, null)).toBe(false)
    expect(canRecategorise({ rule: 4, mechanism: 'payment-app-out' }, null)).toBe(false)
    expect(canRecategorise({ rule: 5, mechanism: 'ordinary-spend' }, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe(false)
    expect(canRecategorise({ rule: 1, mechanism: 'card-payment-pair' }, null)).toBe(false)
    // Spend today, but still carrying the code R2 would pair on once its other leg syncs.
    expect(canRecategorise({ rule: 7, mechanism: 'ordinary-spend' }, 'TRANSFER_OUT_ACCOUNT_TRANSFER')).toBe(false)
  })
})

describe('PATCH /transactions/:id category', () => {
  it('counts a purchase moved to Shopping under Shopping — not Other', async () => {
    const res = await patch('lunch', { category: 'Shopping' })
    expect(res.status).toBe(200)
    expect(res.body.transaction).toMatchObject({
      id: ids.lunch, displayCategory: 'Shopping', category: 'Shopping', categoryEditable: true,
      meaning: { kind: 'spend', label: 'Spending' },
    })

    const row = await stored('lunch')
    expect(row.categoryPrimary).toBe('GENERAL_MERCHANDISE')
    expect(row.categoryDetailed).toBe('GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE')

    const breakdown = await request(app).get('/transactions/categories').set('X-Test-User', USER)
    const byBucket = new Map((breakdown.body.categories as Array<{ category: string; amount: number }>)
      .map((c) => [c.category, c.amount]))
    expect(byBucket.get('Shopping')).toBe(42.17)
    expect(byBucket.has('Other')).toBe(false)
  })

  it('round-trips every assignable category into the totals', async () => {
    for (const category of ASSIGNABLE_CATEGORIES) {
      const res = await patch('looper', { category })
      expect(res.status, category).toBe(200)
      expect(res.body.transaction.displayCategory, category).toBe(category)
      expect(res.body.transaction.meaning.kind, category).toBe('spend')

      const breakdown = await request(app).get('/transactions/categories').set('X-Test-User', USER)
      const bucket = (breakdown.body.categories as Array<{ category: string; amount: number }>)
        .find((c) => c.category === category)
      const expected = category === 'Shopping' ? 42.17 + 13.03 : 13.03
      expect(bucket?.amount, category).toBeCloseTo(expected, 2)
    }
  })

  it.each([['Groceries'], ['GENERAL_MERCHANDISE'], ['Subscriptions'], [''], [42], [null]])(
    'refuses %j with 400 and changes nothing',
    async (category) => {
      const before = await stored('lunch')
      const res = await patch('lunch', { category, notes: 'should not save either' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Unknown category/)
      expect(JSON.stringify(await stored('lunch'))).toBe(JSON.stringify(before))
    },
  )

  it.each([['xfer-out', 'internal_transfer'], ['pay-out', 'card_payment'], ['pay-in', 'card_payment']])(
    'refuses to recategorise %s (a %s) with 409 and keeps its Plaid codes',
    async (name, kind) => {
      const before = await stored(name)
      const res = await patch(name, { category: 'Shopping' })
      expect(res.status).toBe(409)
      expect(JSON.stringify(await stored(name))).toBe(JSON.stringify(before))

      const search = await request(app).get('/transactions/search').set('X-Test-User', USER)
      const row = (search.body.transactions as Array<{ id: string; meaning: { kind: string }; categoryEditable: boolean }>)
        .find((t) => t.id === ids[name])
      expect(row?.meaning.kind).toBe(kind)
      expect(row?.categoryEditable).toBe(false)
    },
  )

  it('saves notes on a non-editable row when the category sent is its current one', async () => {
    // The panel resends the category it opened with alongside a notes edit.
    const res = await patch('xfer-out', { category: 'Other', notes: 'moving money' })
    expect(res.status).toBe(200)
    expect(res.body.transaction).toMatchObject({ notes: 'moving money', meaning: { kind: 'internal_transfer' } })
    const row = await stored('xfer-out')
    expect(row.categoryDetailed).toBe('TRANSFER_OUT_ACCOUNT_TRANSFER')
  })

  it("still 404s on another user's transaction", async () => {
    const before = await stored('lunch')
    const res = await patch('lunch', { category: 'Travel' }, OTHER_USER)
    expect(res.status).toBe(404)
    expect(JSON.stringify(await stored('lunch'))).toBe(JSON.stringify(before))
  })
})

describe('GET /transactions/category-options', () => {
  it('lists exactly the assignable categories, with colours', async () => {
    const res = await request(app).get('/transactions/category-options').set('X-Test-User', USER)
    expect(res.status).toBe(200)
    expect(res.body.map((c: { category: string }) => c.category)).toEqual([...ASSIGNABLE_CATEGORIES])
    for (const c of res.body) expect(c.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
