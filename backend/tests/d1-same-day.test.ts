// ─────────────────────────────────────────────────────────────────
//  tests/d1-same-day.test.ts — R2's same-day pass (D1)
//
//  A user moved money between their own accounts and typed "rent" as the
//  memo; Plaid coded the outflow RENT_AND_UTILITIES at HIGH confidence. Only
//  the inflow carried a transfer code, so R2 — which needs a signal on both
//  legs — counted it as rent plus income. The same-day pass pairs that shape
//  and nothing wider. These pin each edge of "nothing wider".
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../src/lib/prisma'
import { encrypt } from '../src/utils/encrypt'
import { classify, type ClassifierTx, type Counterparty } from '../src/lib/classifier'
import { classifyWindow } from '../src/services/classification.service'

const D = (day: number) => new Date(Date.UTC(2026, 0, day))
const tx = (over: Partial<ClassifierTx> & { id: string }): ClassifierTx => ({
  accountId: 'savings', accountType: 'depository', date: D(10), amount: 900,
  categoryPrimary: 'RENT_AND_UTILITIES', categoryDetailed: 'RENT_AND_UTILITIES_RENT',
  confidence: 'HIGH', counterparties: [], pending: false,
  ...over,
})
const transferIn = (over: Partial<ClassifierTx> & { id: string }) =>
  tx({ accountId: 'checking', amount: -900, categoryPrimary: 'TRANSFER_IN', categoryDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', confidence: 'VERY_HIGH', ...over })
const options = (sameDayTransferPairs?: boolean) => ({
  linkedInstitutions: ['Home Credit Union'], institutionsWithCreditAccount: [],
  periodKeyOf: () => '2026-01-01', sameDayTransferPairs,
})
const verdicts = (rows: ClassifierTx[], opts = options()) => classify(rows, opts).byId

describe('the same-day pass in the classifier', () => {
  it('pairs the incident: outflow naming no one, inflow transfer-coded, same day', () => {
    const v = verdicts([tx({ id: 'out' }), transferIn({ id: 'in' })])
    for (const id of ['out', 'in']) {
      expect(v.get(id), id).toMatchObject({ kind: 'internal_transfer', rule: 2, mechanism: 'internal-transfer-same-day' })
    }
    expect(v.get('out')!.partnerId).toBe('in')
  })

  it.each<[string, Counterparty]>([
    ['a landlord (merchant)', { name: 'Greystone Apartments', type: 'merchant' }],
    ['a lender (financial institution, not linked)', { name: 'Summit Auto Finance', type: 'financial_institution' }],
    ['a person through an app', { name: 'Venmo', type: 'payment_app' }],
  ])('refuses when the outflow names %s: a real bill names who it paid', (_, cp) => {
    const v = verdicts([tx({ id: 'out', counterparties: [cp] }), transferIn({ id: 'in' })])
    expect(v.get('out')!.mechanism).not.toMatch(/internal-transfer/)
    expect(v.get('in')!.mechanism).not.toMatch(/internal-transfer/)
  })

  it('refuses one day apart', () => {
    const v = verdicts([tx({ id: 'out' }), transferIn({ id: 'in', date: D(11) })])
    expect(v.get('out')).toMatchObject({ kind: 'spend' })
    expect(v.get('in')).toMatchObject({ kind: 'income' })
  })

  it('refuses the mirror image — coded outflow, uncoded inflow — deliberately', () => {
    // No real instance exists, and this is the direction that can change net
    // saved: the inflow might have been unidentified rather than income.
    const v = verdicts([
      tx({ id: 'out', categoryPrimary: 'TRANSFER_OUT', categoryDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' }),
      tx({ id: 'in', accountId: 'checking', amount: -900, categoryPrimary: 'OTHER', categoryDetailed: 'OTHER_OTHER' }),
    ])
    expect(v.get('out')!.mechanism).not.toBe('internal-transfer-same-day')
    expect(v.get('in')!.mechanism).not.toBe('internal-transfer-same-day')
  })

  it('refuses a pair within one account, and a pair that isn\'t exact to the cent', () => {
    expect(verdicts([tx({ id: 'out' }), transferIn({ id: 'in', accountId: 'savings' })]).get('out')!.kind).toBe('spend')
    expect(verdicts([tx({ id: 'out' }), transferIn({ id: 'in', amount: -900.01 })]).get('out')!.kind).toBe('spend')
  })

  it('lets a both-legs pair claim first, so an existing R2 pair is never re-decided', () => {
    // A coded outflow and a bare outflow both match the same inflow on day 0.
    // The both-legs pass runs first and takes it; the bare one stays spend.
    const v = verdicts([
      tx({ id: 'coded-out', categoryPrimary: 'TRANSFER_OUT', categoryDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' }),
      tx({ id: 'bare-out', accountId: 'other' }),
      transferIn({ id: 'in' }),
    ])
    expect(v.get('coded-out')).toMatchObject({ mechanism: 'internal-transfer-pair', partnerId: 'in' })
    expect(v.get('bare-out')!.kind).toBe('spend')
  })

  it('is on unless the measurement switch turns it off', () => {
    const rows = [tx({ id: 'out' }), transferIn({ id: 'in' })]
    expect(verdicts(rows, options(undefined)).get('out')!.kind).toBe('internal_transfer')
    expect(verdicts(rows, options(false)).get('out')!.kind).toBe('spend')
  })
})

// ── across users, through the database ────────────────────────────

const A = 'd1-sameday-user-a'
const B = 'd1-sameday-user-b'
const C = 'd1-sameday-user-c'
const DAY_MS = 86_400_000

async function cleanup() {
  for (const u of [A, B, C]) {
    await prisma.transaction.deleteMany({ where: { userId: u } })
    await prisma.account.deleteMany({ where: { userId: u } })
    await prisma.plaidItem.deleteMany({ where: { userId: u } })
    await prisma.user.deleteMany({ where: { id: u } })
  }
}

async function makeUser(id: string) {
  await prisma.user.create({ data: { id, email: `${id}@d1.local` } })
  const item = await prisma.plaidItem.create({
    data: { userId: id, itemId: `${id}-item`, accessToken: encrypt(`t-${id}`), institutionName: `${id} CU` },
  })
  const account = (name: string, subtype: string) => prisma.account.create({
    data: {
      userId: id, plaidItemId: item.id, plaidAccountId: `${id}-${name}`, name, type: 'depository', subtype,
      currentBalance: '1000.00', isoCurrencyCode: 'USD',
    },
  })
  return { savings: await account('Savings', 'savings'), checking: await account('Checking', 'checking') }
}

const today = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * DAY_MS)
}
const row = (userId: string, accountId: string, id: string, amount: string, primary: string, detailed: string) => ({
  userId, accountId, plaidTransactionId: `${userId}-${id}`, date: today(), amount, name: id.toUpperCase(),
  categoryPrimary: primary, categoryDetailed: detailed, isoCurrencyCode: 'USD', pending: false,
  rawJson: { personal_finance_category: { primary, detailed, confidence_level: 'HIGH' }, counterparties: [] },
})

const window = () => ({ since: new Date(today().getTime() - DAY_MS), until: new Date(today().getTime() + DAY_MS), startDay: 1 })

beforeAll(async () => {
  await cleanup()
  const a = await makeUser(A)
  const b = await makeUser(B)
  const c = await makeUser(C)
  await prisma.transaction.createMany({
    data: [
      // The incident split across two DIFFERENT users: outflow on A, inflow on B.
      row(A, a.savings.id, 'out', '900.00', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT'),
      row(B, b.checking.id, 'in', '-900.00', 'TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER'),
      // Positive control: the same two rows, both on C. Without it the
      // cross-user case could pass because the rule never fires at all.
      row(C, c.savings.id, 'out', '900.00', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT'),
      row(C, c.checking.id, 'in', '-900.00', 'TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER'),
    ],
  })
})

afterAll(cleanup)

describe('the same-day pass never pairs across users', () => {
  it('pairs the shape when both legs belong to one user (control)', async () => {
    const { rows } = await classifyWindow(C, window())
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.verdict.mechanism).toBe('internal-transfer-same-day')
  })

  it('leaves the same two rows alone when they belong to different users', async () => {
    const [{ rows: aRows }, { rows: bRows }] = await Promise.all([classifyWindow(A, window()), classifyWindow(B, window())])
    expect(aRows).toHaveLength(1)
    expect(bRows).toHaveLength(1)
    expect(aRows[0].verdict).toMatchObject({ kind: 'spend', mechanism: 'ordinary-spend' })
    expect(bRows[0].verdict).toMatchObject({ kind: 'income' })
  })
})
