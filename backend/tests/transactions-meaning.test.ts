// ─────────────────────────────────────────────────────────────────
//  tests/transactions-meaning.test.ts — transaction rows carry their verdict
//
//  The list used to colour a row by the sign of its amount, so a card payment
//  rendered red as spending while every total said it wasn't. Rows now carry
//  the classifier's verdict and a label for it.
//
//  The case worth pinning: a page — or a search — that contains only ONE leg of
//  a pair. Classifying just the rows on the page would call that leg spending.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'

const USER = 'transactions-meaning-test-user'
const DAY_MS = 86_400_000

type Row = { displayName: string; meaning: { kind: string; label: string } }

async function cleanup() {
  await prisma.transaction.deleteMany({ where: { userId: USER } })
  await prisma.account.deleteMany({ where: { userId: USER } })
  await prisma.plaidItem.deleteMany({ where: { userId: USER } })
  await prisma.user.deleteMany({ where: { id: USER } })
}

const search = (query = '') =>
  request(app).get(`/transactions/search${query}`).set('X-Test-User', USER)

beforeAll(async () => {
  await cleanup()
  await prisma.user.create({ data: { id: USER, email: `${USER}@meaning-test.local` } })
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

  const today = new Date()
  const day = (back: number) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - back * DAY_MS)
  const row = (id: string, accountId: string, back: number, amount: string, name: string, primary: string, detailed: string) => ({
    userId: USER, accountId, plaidTransactionId: `${USER}-${id}`, date: day(back), amount, name,
    cleanName: name, categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD', pending: false,
  })

  await prisma.transaction.createMany({
    data: [
      // Newest first once sorted: the card-payment outflow, its partner two days earlier.
      row('pay-out', checking.id, 0, '812.34', 'CARD PAYMENT', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
      row('pay-in', card.id, 2, '-812.34', 'PAYMENT THANK YOU', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
      row('xfer-out', checking.id, 4, '300.00', 'TO SAVINGS', 'TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'),
      row('xfer-in', savings.id, 4, '-300.00', 'FROM CHECKING', 'TRANSFER_IN', 'TRANSFER_IN_SAVINGS'),
      row('coffee', card.id, 6, '5.25', 'BLUE BOTTLE', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'),
    ],
  })
})

afterAll(cleanup)

describe('transaction rows carry the classifier verdict', () => {
  it('labels every kind the fixture contains', async () => {
    const res = await search()
    expect(res.status).toBe(200)
    const byName = new Map((res.body.transactions as Row[]).map((t) => [t.displayName, t.meaning]))
    expect(byName.get('CARD PAYMENT')).toEqual({ kind: 'card_payment', label: 'Card payment' })
    expect(byName.get('PAYMENT THANK YOU')).toEqual({ kind: 'card_payment', label: 'Card payment' })
    expect(byName.get('TO SAVINGS')).toEqual({ kind: 'internal_transfer', label: 'Transfer' })
    expect(byName.get('BLUE BOTTLE')).toEqual({ kind: 'spend', label: 'Spending' })
  })

  it('labels a pair correctly when the page holds only one leg of it', async () => {
    // One row per page: the newest is the card-payment outflow, alone.
    const res = await search('?limit=1')
    const [only] = res.body.transactions as Row[]
    expect(only.displayName).toBe('CARD PAYMENT')
    expect(only.meaning.kind).toBe('card_payment') // not "spend", though its partner is on another page
  })

  it('labels a pair correctly when a search matches only one leg of it', async () => {
    const res = await search('?q=THANK')
    const rows = res.body.transactions as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0].meaning.kind).toBe('card_payment') // its partner doesn't match the search at all
  })
})
