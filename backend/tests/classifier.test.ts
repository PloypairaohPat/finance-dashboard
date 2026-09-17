// ─────────────────────────────────────────────────────────────────
//  tests/classifier.test.ts — the classifier against the seed's manifest (M7.3)
//
//  demo-dataset.ts states what every row MUST be classified as and why. This
//  runs the real classifier over those rows and compares, so the manifest stops
//  being documentation and becomes the specification.
//
//  Failures here should be read as: either the classifier is wrong, or a
//  decision changed and the manifest was not updated with it. Rows whose
//  expectation depends on a decision carry its D-number for exactly that reason.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import {
  DEMO_ACCOUNTS,
  DEMO_ITEMS,
  buildDemoDataset,
  type DemoTransaction,
} from '../prisma/demo-dataset'
import {
  MAX_RULE_LOOKBACK_DAYS,
  R1_WINDOW_DAYS,
  R2_WINDOW_DAYS,
  classify,
  type ClassifierTx,
  type Mechanism,
} from '../src/lib/classifier'
import { PAIRING_PAD_DAYS } from '../src/services/classification.service'
import { periodKeyOf } from '../src/lib/period'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const ds = buildDemoDataset(NOW)

const accountType = (key: string) => DEMO_ACCOUNTS.find((a) => a.key === key)!.type
const institutionOf = (accountKey: string) =>
  DEMO_ITEMS.find((i) => i.key === DEMO_ACCOUNTS.find((a) => a.key === accountKey)!.itemKey)!.institutionName

const toInput = (t: DemoTransaction): ClassifierTx => ({
  id: t.plaidTransactionId,
  accountId: t.accountKey,
  accountType: accountType(t.accountKey),
  date: t.date,
  amount: t.amount,
  categoryPrimary: t.primary,
  categoryDetailed: t.detailed,
  confidence: t.confidence,
  counterparties: t.counterparties,
  pending: t.pending,
})

const options = {
  linkedInstitutions: DEMO_ITEMS.map((i) => i.institutionName),
  institutionsWithCreditAccount: DEMO_ACCOUNTS.filter((a) => a.type === 'credit').map((a) =>
    institutionOf(a.key),
  ),
  periodKeyOf: (d: Date) => periodKeyOf(d, ds.startDay),
}

const inputs = ds.transactions.map(toInput)
const result = classify(inputs, options)

describe('the classifier agrees with the manifest on every row', () => {
  it('classifies every transaction exactly once', () => {
    expect(result.byId.size).toBe(ds.transactions.length)
  })

  it('agrees on kind for every row', () => {
    const wrong = ds.transactions
      .filter((t) => result.byId.get(t.plaidTransactionId)!.kind !== t.expected.kind)
      .map((t) => ({
        id: t.plaidTransactionId,
        detailed: t.detailed,
        expected: t.expected.kind,
        got: result.byId.get(t.plaidTransactionId)!.kind,
        why: result.byId.get(t.plaidTransactionId)!.reason,
      }))
    expect(wrong).toEqual([])
  })

  it('agrees on which rule decided it', () => {
    const wrong = ds.transactions
      .filter((t) => result.byId.get(t.plaidTransactionId)!.rule !== t.expected.rule)
      .map((t) => ({
        id: t.plaidTransactionId,
        expected: `R${t.expected.rule}`,
        got: `R${result.byId.get(t.plaidTransactionId)!.rule}`,
      }))
    expect(wrong).toEqual([])
  })

  it('agrees on spend buckets and on what a refund nets against', () => {
    for (const t of ds.transactions) {
      const got = result.byId.get(t.plaidTransactionId)!
      if (t.expected.kind === 'spend') {
        expect(got.bucket, t.plaidTransactionId).toBe(t.expected.bucket)
      }
      if (t.expected.kind === 'refund') {
        expect(got.netsAgainst ?? null, t.plaidTransactionId).toBe(t.expected.netsAgainst)
      }
    }
  })

  it('pairs both legs to each other', () => {
    for (const t of ds.transactions) {
      const got = result.byId.get(t.plaidTransactionId)!
      if (got.rule !== 1 && got.rule !== 2) continue
      expect(got.partnerId, t.plaidTransactionId).toBeTruthy()
      expect(result.byId.get(got.partnerId!)!.partnerId).toBe(t.plaidTransactionId)
    }
  })
})

describe('each named case classifies as the manifest says', () => {
  it.each(ds.cases.map((c) => [c.id, c.branch, c.note] as const))('%s (%s)', (id) => {
    const c = ds.cases.find((x) => x.id === id)!
    for (const txId of c.txIds) {
      const expected = ds.transactions.find((t) => t.plaidTransactionId === txId)!.expected
      const got = result.byId.get(txId)!
      expect({ kind: got.kind, rule: got.rule }, `${txId}: ${got.reason}`).toEqual({
        kind: expected.kind,
        rule: expected.rule,
      })
    }
  })
})

describe('the payment-app cap comes out where the manifest says', () => {
  it('matches every completed period', () => {
    for (const expected of ds.paymentApp) {
      const got = result.paymentApp.find((p) => p.key === expected.periodKey)
      expect(got, expected.periodKey).toBeDefined()
      expect(got!.out).toBeCloseTo(expected.out, 2)
      expect(got!.in).toBeCloseTo(expected.in, 2)
      expect(got!.spend).toBeCloseTo(expected.netSpend, 2)
      expect(got!.surplus).toBeCloseTo(expected.surplus, 2)
    }
  })
})

describe('classifying a slice of history needs padding at the edges', () => {
  const makeRow = (over: Partial<ClassifierTx> & { id: string }): ClassifierTx => ({
    accountId: 'checking',
    accountType: 'depository',
    date: '2026-06-01',
    amount: 100,
    categoryPrimary: 'LOAN_PAYMENTS',
    categoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    confidence: 'HIGH',
    counterparties: [],
    pending: false,
    ...over,
  })

  // A card payment on the last day of June, settling on the card in July.
  const payment = makeRow({ id: 'pay', date: '2026-06-30', amount: 480 })
  const settles = makeRow({
    id: 'settle', date: '2026-07-02', amount: -480, accountId: 'card', accountType: 'credit',
  })
  const opts = {
    linkedInstitutions: ['Demo Bank'],
    institutionsWithCreditAccount: ['Demo Bank'],
    periodKeyOf: (d: Date) => periodKeyOf(d, 1),
  }

  it('finds the pair when both sides are loaded', () => {
    const both = classify([payment, settles], opts)
    expect(both.byId.get('pay')!.kind).toBe('card_payment')
    expect(both.byId.get('settle')!.kind).toBe('card_payment')
  })

  it('and gets both legs wrong when the slice stops at the period boundary', () => {
    // This is the failure the padding prevents: June sees a payment it calls
    // spend, July sees an inflow it cannot pair.
    const juneOnly = classify([payment], opts)
    expect(juneOnly.byId.get('pay')!.kind).toBe('spend')
    const julyOnly = classify([settles], opts)
    expect(julyOnly.byId.get('settle')!.kind).not.toBe('card_payment')
  })

  it('pads by at least the furthest any rule looks, derived from the rules', () => {
    expect(MAX_RULE_LOOKBACK_DAYS).toBe(Math.max(R1_WINDOW_DAYS, R2_WINDOW_DAYS))
    expect(PAIRING_PAD_DAYS).toBeGreaterThanOrEqual(MAX_RULE_LOOKBACK_DAYS)
  })
})

describe('the classifier is order-independent and explains itself', () => {
  it('gives the same verdicts when the input order is shuffled', () => {
    const shuffled = [...inputs]
    // Deterministic shuffle: reverse, then interleave, so pairing order differs.
    shuffled.reverse()
    const mixed = [
      ...shuffled.filter((_, i) => i % 2 === 0),
      ...shuffled.filter((_, i) => i % 2 === 1),
    ]
    const other = classify(mixed, options)
    for (const [id, verdict] of result.byId) {
      const got = other.byId.get(id)!
      expect({ kind: got.kind, rule: got.rule, partnerId: got.partnerId }, id).toEqual({
        kind: verdict.kind,
        rule: verdict.rule,
        partnerId: verdict.partnerId,
      })
    }
  })

  it('names a mechanism for every row, and covers every mechanism the rules can produce', () => {
    for (const [id, v] of result.byId) {
      expect(v.mechanism, id).toBeTruthy()
      expect(v.reason.length, id).toBeGreaterThan(10)
    }
    const seen = new Set<Mechanism>([...result.byId.values()].map((v) => v.mechanism))
    const required: Mechanism[] = [
      'card-payment-pair',
      'card-payment-unpaired',
      'internal-transfer-pair',
      'linked-bank-exclusion',
      'savings-exclusion',
      'refund',
      'refund-unallocated',
      'credit-inflow-not-income',
      'payment-app-out',
      'payment-app-in',
      'income-definition-c',
      'unclassified-inflow',
      'ordinary-spend',
    ]
    expect([...required].filter((m) => !seen.has(m))).toEqual([])
  })
})
