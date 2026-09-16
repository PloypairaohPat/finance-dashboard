// ─────────────────────────────────────────────────────────────────
//  tests/demo-dataset.test.ts — the demo seed as a classifier fixture (M7.3)
//
//  These tests check the FIXTURE, not the classifier (which M7.3 task 3 will
//  build). They prove three things:
//
//    1. Every named case really has the property that makes it a trap — the
//       withdrawal really does name a linked bank, the near-miss really is one
//       cent out, the 8-day pair really is 8 days apart. Each case has its own
//       assertion, and a case with no assertion fails the suite.
//    2. The branches real data never exercised carry the heaviest coverage:
//       an easy case, near-misses either side of the boundary, and a case a
//       neighbouring rule would wrongly claim.
//    3. Nothing pairs by accident. The only exact-amount, in-window pairs in
//       the whole seed are the ones the manifest declares — checked across ~130
//       different "today"s, because the seed's dates are relative to when it runs.
//
//  The pairing helpers below implement the GEOMETRY of R1/R2 only (amount, date
//  window, account type, counterparty veto, transfer signal). They are not the
//  classifier: no bucketing, no gate, no ordering.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import {
  DEMO_ACCOUNTS,
  DEMO_ITEMS,
  GATE_PASSING_CONFIDENCE,
  LINKED_BANK_ALLOWLIST,
  MONTHS_OF_HISTORY,
  PAYMENTS_TO_PEOPLE,
  SAVINGS_EXCLUSION_CODES,
  UNTESTED_BRANCHES,
  buildDemoDataset,
  primaryOf,
  toRawJson,
  type CaseRole,
  type DemoTransaction,
} from '../prisma/demo-dataset'
import { mapPlaidCategory } from '../src/lib/categoryMap'

const NOW = new Date('2026-09-15T12:00:00.000Z')
const ds = buildDemoDataset(NOW)

// ── helpers ───────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const linkedInstitutions = new Set(DEMO_ITEMS.map((i) => norm(i.institutionName)))
const institutionsWithLinkedCard = new Set(
  DEMO_ACCOUNTS.filter((a) => a.type === 'credit').map(
    (a) => norm(DEMO_ITEMS.find((i) => i.key === a.itemKey)!.institutionName),
  ),
)
const accountType = (key: string) => DEMO_ACCOUNTS.find((a) => a.key === key)!.type

const cents = (n: number) => Math.round(n * 100)
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86_400_000
const gapDays = (a: DemoTransaction, b: DemoTransaction) => Math.abs(dayNumber(a.date) - dayNumber(b.date))

const hasLinkedBankCp = (t: DemoTransaction) =>
  t.counterparties.some((c) => c.type === 'financial_institution' && linkedInstitutions.has(norm(c.name)))
const hasVetoCp = (t: DemoTransaction) =>
  t.counterparties.some((c) => c.type === 'merchant' || c.type === 'marketplace' || c.type === 'payment_app')
const hasPaymentAppCp = (t: DemoTransaction) => t.counterparties.some((c) => c.type === 'payment_app')
const hasMerchantCp = (t: DemoTransaction) =>
  t.counterparties.some((c) => c.type === 'merchant' || c.type === 'marketplace')
const hasTransferSignal = (t: DemoTransaction) =>
  /^TRANSFER_(IN|OUT)_/.test(t.detailed) || hasLinkedBankCp(t)
const gatePasses = (t: DemoTransaction) =>
  t.confidence !== null && (GATE_PASSING_CONFIDENCE as readonly string[]).includes(t.confidence)

const isDepositoryOut = (t: DemoTransaction) => t.amount > 0 && accountType(t.accountKey) === 'depository'
const isDepositoryIn = (t: DemoTransaction) => t.amount < 0 && accountType(t.accountKey) === 'depository'
const isCreditIn = (t: DemoTransaction) => t.amount < 0 && accountType(t.accountKey) === 'credit'

/** Index rows by absolute amount in cents, so candidate lookups stay cheap. */
function indexByAmount(rows: DemoTransaction[]): Map<number, DemoTransaction[]> {
  const out = new Map<number, DemoTransaction[]>()
  for (const t of rows) {
    const k = Math.abs(cents(t.amount))
    const arr = out.get(k) ?? []
    arr.push(t)
    out.set(k, arr)
  }
  return out
}

/** R1 geometry: depository outflow ↔ credit inflow, exact, ≤ 7 days, no vetoed leg (D2). */
function r1Candidates(t: DemoTransaction, byAmount: Map<number, DemoTransaction[]>): DemoTransaction[] {
  if (hasVetoCp(t)) return []
  const same = byAmount.get(Math.abs(cents(t.amount))) ?? []
  if (isDepositoryOut(t)) return same.filter((o) => isCreditIn(o) && !hasVetoCp(o) && gapDays(t, o) <= 7)
  if (isCreditIn(t)) return same.filter((o) => isDepositoryOut(o) && !hasVetoCp(o) && gapDays(t, o) <= 7)
  return []
}

/** R2 geometry: depository ↔ depository, exact, ≤ 3 days, transfer signal on BOTH legs (D1). */
function r2Candidates(t: DemoTransaction, byAmount: Map<number, DemoTransaction[]>): DemoTransaction[] {
  if (!hasTransferSignal(t)) return []
  const same = byAmount.get(Math.abs(cents(t.amount))) ?? []
  const ok = (o: DemoTransaction) =>
    o.accountKey !== t.accountKey && hasTransferSignal(o) && gapDays(t, o) <= 3
  if (isDepositoryOut(t)) return same.filter((o) => isDepositoryIn(o) && ok(o))
  if (isDepositoryIn(t)) return same.filter((o) => isDepositoryOut(o) && ok(o))
  return []
}

const byId = (id: string): DemoTransaction => {
  const row = ds.transactions.find((t) => t.plaidTransactionId === id)
  if (!row) throw new Error(`no transaction ${id}`)
  return row
}
const rowsOf = (caseId: string): DemoTransaction[] => {
  const c = ds.cases.find((x) => x.id === caseId)
  if (!c) throw new Error(`no case ${caseId}`)
  return c.txIds.map(byId)
}
const periodOf = (t: DemoTransaction) => `${t.date.slice(0, 7)}-01`

// ── 1. the dataset itself ─────────────────────────────────────────

describe('the demo dataset is deterministic and well formed', () => {
  it('builds identically twice for the same "now"', () => {
    expect(buildDemoDataset(NOW)).toEqual(buildDemoDataset(NOW))
  })

  it('has unique transaction ids and known accounts', () => {
    const ids = ds.transactions.map((t) => t.plaidTransactionId)
    expect(new Set(ids).size).toBe(ids.length)
    const keys = new Set(DEMO_ACCOUNTS.map((a) => a.key))
    for (const t of ds.transactions) expect(keys.has(t.accountKey)).toBe(true)
  })

  it('never dates a row in the future, and only today can be pending', () => {
    const today = NOW.toISOString().slice(0, 10)
    for (const t of ds.transactions) {
      expect(t.date <= today).toBe(true)
      if (t.pending) expect(t.date).toBe(today)
    }
  })

  it('uses real Plaid codes: every detailed code resolves to its primary', () => {
    for (const t of ds.transactions) expect(t.primary).toBe(primaryOf(t.detailed))
  })

  it('carries the full history and ~85 transactions in each completed period', () => {
    const counts = new Map<string, number>()
    for (const t of ds.transactions) counts.set(periodOf(t), (counts.get(periodOf(t)) ?? 0) + 1)
    expect(counts.size).toBe(MONTHS_OF_HISTORY)
    const completed = [...counts.entries()].sort().slice(0, -1)
    for (const [period, n] of completed) {
      expect(n, `${period} has ${n} transactions`).toBeGreaterThanOrEqual(75)
      expect(n, `${period} has ${n} transactions`).toBeLessThanOrEqual(105)
    }
  })

  it('writes rawJson the app can read, and omits confidence when it is missing', () => {
    const withConfidence = toRawJson(byId(ds.transactions[0].plaidTransactionId), 'demo-acct-checking')
    expect((withConfidence.personal_finance_category as Record<string, string>).confidence_level).toBeTruthy()
    const missing = ds.transactions.find((t) => t.confidence === null)!
    const raw = toRawJson(missing, 'demo-acct-card')
    expect(Object.keys(raw.personal_finance_category as object)).toEqual(['primary', 'detailed'])
    expect(raw.counterparties).toEqual(missing.counterparties)
  })
})

// ── 2. expectations are internally consistent ─────────────────────

describe('every expectation is consistent with the row it describes', () => {
  it('spend lands in mapPlaidCategory\'s bucket, except payments to people', () => {
    for (const t of ds.transactions) {
      if (t.expected.kind !== 'spend') continue
      if (t.expected.rule === 4) {
        expect(t.expected.bucket).toBe(PAYMENTS_TO_PEOPLE)
        expect(hasPaymentAppCp(t)).toBe(true)
      } else {
        expect(t.expected.bucket, t.plaidTransactionId).toBe(mapPlaidCategory(t.primary))
      }
    }
  })

  it('credit-account inflows are never income and never unclassified', () => {
    for (const t of ds.transactions) {
      if (!isCreditIn(t)) continue
      expect(['card_payment', 'refund', 'credit_inflow_not_income'], t.plaidTransactionId)
        .toContain(t.expected.kind)
    }
  })

  it('refunds need a merchant counterparty, and net only when the gate passes', () => {
    for (const t of ds.transactions) {
      if (t.expected.kind !== 'refund') continue
      expect(hasMerchantCp(t), t.plaidTransactionId).toBe(true)
      expect(t.expected.netsAgainst, t.plaidTransactionId)
        .toBe(gatePasses(t) ? mapPlaidCategory(t.primary) : null)
    }
  })

  it('an unpaired row is only excluded when an allowlisted code says so (D4)', () => {
    for (const t of ds.transactions) {
      if (t.expected.kind !== 'internal_transfer' || t.expected.rule === 2) continue
      expect((LINKED_BANK_ALLOWLIST as readonly string[]), t.plaidTransactionId).toContain(t.detailed)
      expect(hasLinkedBankCp(t), t.plaidTransactionId).toBe(true)
      expect(gatePasses(t), t.plaidTransactionId).toBe(true)
    }
  })

  it('savings exclusions use a savings code, pass the gate, and name no linked bank', () => {
    for (const t of ds.transactions) {
      if (t.expected.kind !== 'savings_transfer') continue
      expect((SAVINGS_EXCLUSION_CODES as readonly string[]), t.plaidTransactionId).toContain(t.detailed)
      expect(gatePasses(t), t.plaidTransactionId).toBe(true)
      expect(hasLinkedBankCp(t), t.plaidTransactionId).toBe(false)
    }
  })

  it('R5 only excludes a card payment when a card is linked at that bank (D3)', () => {
    for (const t of ds.transactions) {
      if (t.expected.kind !== 'card_payment' || t.expected.rule !== 5) continue
      expect(t.detailed).toBe('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')
      expect(gatePasses(t), t.plaidTransactionId).toBe(true)
      const matched = t.counterparties.some(
        (c) => c.type === 'financial_institution' && institutionsWithLinkedCard.has(norm(c.name)),
      )
      expect(matched, t.plaidTransactionId).toBe(true)
    }
  })

  it('the linked-bank trap generalises: nothing off the allowlist is ever dropped', () => {
    for (const t of ds.transactions) {
      if (!hasLinkedBankCp(t)) continue
      if (t.expected.kind === 'internal_transfer' && t.expected.rule === 2) continue // a real pair
      if (t.detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') continue // R5's own branch
      if ((LINKED_BANK_ALLOWLIST as readonly string[]).includes(t.detailed)) continue
      // A credit-account inflow has no exclusion path to fall into: R3 decides it
      // before any linked-bank rule, and it is never income by definition.
      const allowed = isCreditIn(t)
        ? ['spend', 'income', 'refund', 'credit_inflow_not_income']
        : ['spend', 'income']
      expect(allowed, `${t.plaidTransactionId} (${t.detailed})`).toContain(t.expected.kind)
    }
  })

  it('payment-app rows are the only rule-4 rows, and credit inflows never reach rule 4', () => {
    for (const t of ds.transactions) {
      if (!hasPaymentAppCp(t)) continue
      if (isCreditIn(t)) {
        expect(t.expected.kind, t.plaidTransactionId).toBe('credit_inflow_not_income')
        continue
      }
      expect(t.expected.rule, t.plaidTransactionId).toBe(4)
    }
  })

  it('card-payment legs mostly disagree on category, so pairing cannot lean on it', () => {
    const outs = ds.transactions.filter(
      (t) => t.expected.kind === 'card_payment' && t.expected.rule === 1 && t.amount > 0,
    )
    const disagreeing = outs.filter((out) => {
      const leg = ds.transactions.find(
        (t) =>
          t.expected.kind === 'card_payment' &&
          t.expected.rule === 1 &&
          cents(t.amount) === -cents(out.amount),
      )!
      return leg.detailed !== out.detailed
    })
    expect(disagreeing.length).toBeGreaterThanOrEqual(3)
  })
})

// ── 3. the payment-app cap (D5) ───────────────────────────────────

describe('the payment-app cap is per period, with the surplus shown (D5)', () => {
  it.each(ds.paymentApp)('period $periodKey nets $netSpend with $surplus surplus', (expectation) => {
    const rows = ds.transactions.filter((t) => periodOf(t) === expectation.periodKey && t.expected.rule === 4)
    const out = rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
    const inflow = rows.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)
    expect(out).toBeCloseTo(expectation.out, 2)
    expect(inflow).toBeCloseTo(expectation.in, 2)
    expect(out - Math.min(out, inflow)).toBeCloseTo(expectation.netSpend, 2)
    expect(Math.max(0, inflow - out)).toBeCloseTo(expectation.surplus, 2)
  })

  it('covers both sides: a period that nets inside the cap and one that overflows', () => {
    expect(ds.paymentApp.some((p) => p.surplus === 0 && p.netSpend > 0)).toBe(true)
    expect(ds.paymentApp.some((p) => p.surplus > 0 && p.netSpend === 0)).toBe(true)
  })

  it('the boundary case: the payment and its repayment fall in different periods', () => {
    const [out] = rowsOf('payment-app-cap-boundary-out')
    const [inflow] = rowsOf('payment-app-cap-boundary-in')
    expect(periodOf(out)).not.toBe(periodOf(inflow))
    expect(cents(out.amount)).toBe(-cents(inflow.amount))
    expect(gapDays(out, inflow)).toBeLessThanOrEqual(4) // days apart, but a period apart
  })
})

// ── 4. every named case, one assertion each ───────────────────────

type CaseCheck = (rows: DemoTransaction[]) => void

const CASE_CHECKS: Record<string, CaseCheck> = {
  // card-payment pairing (R1)
  'card-payment-pair-easy': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(2)
    expect(cents(out.amount)).toBe(-cents(inflow.amount))
    expect(out.expected).toEqual({ kind: 'card_payment', rule: 1 })
    expect(inflow.expected).toEqual({ kind: 'card_payment', rule: 1 })
  },
  'r1-window-inside-7-days': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(7)
    expect(out.expected.kind).toBe('card_payment')
    expect(inflow.expected.kind).toBe('card_payment')
  },
  'r1-window-outside-8-days': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(8)
    expect(out.expected).toMatchObject({ kind: 'spend', rule: 5, bucket: 'Debt' })
    expect(inflow.expected.kind).toBe('credit_inflow_not_income')
  },
  'r1-amount-one-cent-under': ([out, inflow]) => {
    expect(cents(out.amount) + cents(inflow.amount)).toBe(1)
    expect(gapDays(out, inflow)).toBeLessThanOrEqual(7)
    expect(out.expected.kind).toBe('spend')
  },
  'r1-amount-one-cent-over': ([out, inflow]) => {
    expect(cents(out.amount) + cents(inflow.amount)).toBe(-1)
    expect(gapDays(out, inflow)).toBeLessThanOrEqual(7)
    expect(out.expected.kind).toBe('spend')
  },
  'r1-wrong-claim-refund': ([purchase, refund]) => {
    expect(cents(purchase.amount)).toBe(-cents(refund.amount))
    expect(gapDays(purchase, refund)).toBeLessThanOrEqual(7)
    expect(hasMerchantCp(purchase) && hasMerchantCp(refund)).toBe(true) // D2 blocks both legs
    expect(purchase.expected.kind).toBe('spend')
    expect(refund.expected.kind).toBe('refund')
  },
  'r1-wrong-claim-statement-credit': ([purchase, credit]) => {
    expect(cents(purchase.amount)).toBe(-cents(credit.amount))
    expect(gapDays(purchase, credit)).toBeLessThanOrEqual(7)
    expect(hasMerchantCp(purchase)).toBe(true)
    expect(credit.counterparties).toEqual([]) // only the debit leg is vetoed, and that is enough
    expect(purchase.expected.kind).toBe('spend')
  },

  // unpaired card payments (R5)
  'r5-linked-bank-with-credit': ([t]) => {
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected).toEqual({ kind: 'card_payment', rule: 5 })
  },
  'r5-institution-name-normalised': ([t]) => {
    const cp = t.counterparties[0]
    expect(cp.name).not.toBe('Demo Bank') // spelled differently…
    expect(norm(cp.name)).toBe(norm('Demo Bank')) // …but normalises onto the linked institution
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected).toEqual({ kind: 'card_payment', rule: 5 })
  },
  'r5-gate-inside-medium': ([t]) => {
    expect(t.confidence).toBe('MEDIUM')
    expect(t.expected.kind).toBe('card_payment')
  },
  'r5-linked-bank-without-credit': ([t]) => {
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.counterparties.some((c) => institutionsWithLinkedCard.has(norm(c.name)))).toBe(false)
    expect(t.expected).toEqual({ kind: 'spend', rule: 5, bucket: 'Debt' })
  },
  'r5-unlinked-issuer': ([t]) => {
    expect(t.counterparties[0].type).toBe('financial_institution')
    expect(hasLinkedBankCp(t)).toBe(false)
    expect(t.expected.kind).toBe('spend')
  },
  'r5-no-counterparty': ([t]) => {
    expect(t.counterparties).toEqual([])
    expect(t.expected.kind).toBe('spend')
  },
  'r5-counterparty-wrong-type': ([t]) => {
    expect(t.counterparties[0].name).toBe('Demo Bank')
    expect(t.counterparties[0].type).toBe('merchant')
    expect(hasLinkedBankCp(t)).toBe(false)
    expect(t.expected.kind).toBe('spend')
  },
  'r5-gate-outside-low': ([t]) => {
    expect(t.confidence).toBe('LOW')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected.kind).toBe('spend')
  },

  // refunds (R3, D7)
  'refund-merchant-counterparty': ([t]) => {
    expect(isCreditIn(t)).toBe(true)
    expect(t.expected).toEqual({ kind: 'refund', rule: 3, netsAgainst: 'Food & Dining' })
  },
  'refund-on-debit-card': ([t]) => {
    expect(isDepositoryIn(t)).toBe(true)
    expect(hasMerchantCp(t)).toBe(true)
    expect(t.decisions).toContain('D7')
    expect(t.expected).toEqual({ kind: 'refund', rule: 3, netsAgainst: 'Shopping' })
  },
  'refund-gate-inside-medium': ([t]) => {
    expect(t.confidence).toBe('MEDIUM')
    expect((t.expected as { netsAgainst: string | null }).netsAgainst).toBe('Shopping')
  },
  'refund-gate-missing-confidence': ([t]) => {
    expect(t.confidence).toBeNull()
    expect(t.expected).toMatchObject({ kind: 'refund', netsAgainst: null })
  },
  'refund-needs-a-counterparty': ([t]) => {
    expect(t.counterparties).toEqual([])
    expect(mapPlaidCategory(t.primary)).toBe('Shopping') // a refund-shaped category…
    expect(t.expected.kind).toBe('credit_inflow_not_income') // …but no evidence
  },
  'refund-bank-counterparty-not-income': ([t]) => {
    expect(t.primary).toBe('INCOME')
    expect(isCreditIn(t)).toBe(true)
    expect(t.expected.kind).toBe('credit_inflow_not_income')
  },
  'payroll-merchant-counterparty': ([t]) => {
    expect(hasMerchantCp(t)).toBe(true)
    expect(t.primary).toBe('INCOME')
    expect(t.expected.kind).toBe('income') // D7 must not read salary as a refund
  },

  // savings transfers (R2 pairing, R7 exclusion)
  'savings-pair-easy': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(0)
    expect(out.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
    expect(inflow.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
  },
  'savings-unpaired': ([t]) => {
    expect(t.detailed).toBe('TRANSFER_OUT_SAVINGS')
    expect(t.expected).toEqual({ kind: 'savings_transfer', rule: 7 })
  },
  'savings-gate-inside-medium': ([t]) => {
    expect(t.confidence).toBe('MEDIUM')
    expect(t.expected.kind).toBe('savings_transfer')
  },
  'savings-gate-outside-low': ([t]) => {
    expect(t.confidence).toBe('LOW')
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'savings-investment-code': ([t]) => {
    expect(t.detailed).toBe('TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS')
    expect(t.expected.kind).toBe('savings_transfer')
  },
  'r2-window-inside-3-days': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(3)
    expect(out.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
  },
  'r2-window-outside-4-days': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(4)
    expect(out.expected.kind).toBe('savings_transfer')
    expect(inflow.expected.kind).toBe('income') // open question 2
  },
  'r2-wrong-claim-tax-refund': ([out, inflow]) => {
    expect(cents(out.amount)).toBe(-cents(inflow.amount))
    expect(gapDays(out, inflow)).toBeLessThanOrEqual(3)
    expect(hasTransferSignal(inflow)).toBe(false) // D1: no signal, no pair
    expect(inflow.expected.kind).toBe('income')
  },

  // the non-card loan
  'loan-car-easy': ([t]) => {
    expect(t.detailed).toBe('LOAN_PAYMENTS_CAR_PAYMENT')
    expect(t.expected).toEqual({ kind: 'spend', rule: 7, bucket: 'Debt' })
  },
  'loan-car-low-confidence': ([t]) => {
    expect(t.confidence).toBe('LOW')
    expect(t.expected).toMatchObject({ kind: 'spend', bucket: 'Debt' })
  },
  'loan-at-your-own-bank': ([t]) => {
    expect(hasLinkedBankCp(t)).toBe(true)
    expect((LINKED_BANK_ALLOWLIST as readonly string[])).not.toContain(t.detailed)
    expect(t.expected).toMatchObject({ kind: 'spend', bucket: 'Debt' })
  },
  'loan-wrong-claim-transfer-in': ([loan, inflow]) => {
    expect(cents(loan.amount)).toBe(-cents(inflow.amount))
    expect(gapDays(loan, inflow)).toBe(0)
    expect(hasTransferSignal(loan)).toBe(false)
    expect(loan.expected.kind).toBe('spend')
  },

  // the rent coincidence
  'rent-covered-by-real-transfer': ([out, inflow, rent]) => {
    expect(cents(out.amount)).toBe(cents(rent.amount))
    expect(out.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
    expect(inflow.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
    expect(rent.expected).toMatchObject({ kind: 'spend' }) // the rent itself still counts
  },
  'rent-coincidence-real-shape': ([rent, inflow]) => {
    expect(cents(rent.amount)).toBe(-cents(inflow.amount))
    expect(gapDays(rent, inflow)).toBe(0)
    expect(rent.accountKey).not.toBe(inflow.accountKey)
    expect(hasTransferSignal(rent)).toBe(false) // D1 keeps them apart
    expect(rent.expected.kind).toBe('spend')
    expect(inflow.expected.kind).toBe('income')
  },
  'rent-coded-but-linked-counterparty': ([out, inflow]) => {
    expect(out.detailed).toBe('RENT_AND_UTILITIES_RENT')
    expect(hasLinkedBankCp(out)).toBe(true) // the signal D1 asks for
    expect(out.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
    expect(inflow.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
  },
  'rent-day-linked-inflow': ([rent, inflow]) => {
    expect(rent.expected.kind).toBe('spend')
    expect(inflow.expected).toEqual({ kind: 'internal_transfer', rule: 6 })
  },
  'rent-coincidence-outside-window': ([out, inflow]) => {
    expect(gapDays(out, inflow)).toBe(4)
    expect(out.expected).toMatchObject({ kind: 'spend' })
    expect(inflow.expected.kind).toBe('income')
  },

  // the withdrawal / linked-bank trap
  'withdrawal-linked-bank': ([t]) => {
    expect(t.detailed).toBe('TRANSFER_OUT_WITHDRAWAL')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect((LINKED_BANK_ALLOWLIST as readonly string[])).not.toContain(t.detailed)
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'withdrawal-no-counterparty': ([t]) => {
    expect(t.counterparties).toEqual([])
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'withdrawal-other-institution': ([t]) => {
    expect(t.accountKey).toBe('nwChecking')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'withdrawal-then-deposit': ([out, inflow]) => {
    expect(out.detailed).toBe('TRANSFER_OUT_WITHDRAWAL')
    expect(inflow.detailed).toBe('TRANSFER_IN_DEPOSIT')
    expect(gapDays(out, inflow)).toBe(1)
    expect(out.expected).toEqual({ kind: 'internal_transfer', rule: 2 })
  },
  'bank-fee-atm': ([t]) => {
    expect(t.primary).toBe('BANK_FEES')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected).toMatchObject({ kind: 'spend', bucket: 'Bills & Utilities' })
  },
  'bank-fee-overdraft': ([t]) => {
    expect(t.primary).toBe('BANK_FEES')
    expect(t.confidence).toBe('LOW')
    expect(t.expected.kind).toBe('spend')
  },
  'bank-branded-p2p': ([t]) => {
    expect(t.detailed).toBe('TRANSFER_OUT_TRANSFER_OUT_FROM_APPS')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(hasPaymentAppCp(t)).toBe(false) // named by the bank, not by an app
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'interest-linked-bank': ([t]) => {
    expect(t.detailed).toBe('INCOME_INTEREST_EARNED')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected.kind).toBe('income')
  },
  'cash-deposit-linked-bank': ([t]) => {
    expect(t.detailed).toBe('TRANSFER_IN_DEPOSIT')
    expect(hasLinkedBankCp(t)).toBe(true)
    expect(t.expected.kind).toBe('income')
  },
  'transfer-out-linked-bank': ([t]) => {
    expect((LINKED_BANK_ALLOWLIST as readonly string[])).toContain(t.detailed)
    expect(t.expected).toEqual({ kind: 'internal_transfer', rule: 7 })
  },
  'transfer-in-linked-bank': ([t]) => {
    expect((LINKED_BANK_ALLOWLIST as readonly string[])).toContain(t.detailed)
    expect(t.expected).toEqual({ kind: 'internal_transfer', rule: 6 })
  },
  'transfer-out-linked-gate-outside': ([t]) => {
    expect(t.confidence).toBe('LOW')
    expect(t.expected).toMatchObject({ kind: 'spend' })
  },
  'transfer-in-linked-gate-outside': ([t]) => {
    expect(t.confidence).toBe('LOW')
    expect(t.expected).toEqual({ kind: 'unclassified_inflow', rule: 6 }) // not income
  },

  // payment apps, unclassified inflows, pending
  'payment-app-cap-net': ([t]) => {
    expect(hasPaymentAppCp(t)).toBe(true)
    expect(t.expected).toMatchObject({ kind: 'spend', rule: 4, bucket: PAYMENTS_TO_PEOPLE })
  },
  'payment-app-cap-surplus': ([t]) => {
    expect(t.expected).toEqual({ kind: 'payment_app_in', rule: 4 })
    const period = ds.paymentApp.find((p) => p.periodKey === periodOf(t))!
    expect(period.surplus).toBeGreaterThan(0)
  },
  'payment-app-cap-boundary-out': ([t]) => {
    const day = Number(t.date.slice(8))
    const lastDayOfMonth = new Date(
      Date.UTC(Number(t.date.slice(0, 4)), Number(t.date.slice(5, 7)), 0),
    ).getUTCDate()
    expect(day).toBe(lastDayOfMonth) // paid on the very last day of the period
    const period = ds.paymentApp.find((p) => p.periodKey === periodOf(t))!
    expect(period.netSpend).toBeGreaterThan(0) // and it stays charged to this period
  },
  'payment-app-cap-boundary-in': ([t]) => {
    expect(t.expected).toEqual({ kind: 'payment_app_in', rule: 4 })
    expect(Number(t.date.slice(8))).toBeLessThanOrEqual(3) // lands early in the next period
  },
  'payment-app-cap-order': ([inflow, out]) => {
    expect(inflow.date < out.date).toBe(true)
    expect(periodOf(inflow)).toBe(periodOf(out))
    expect(cents(-inflow.amount)).toBe(cents(out.amount))
  },
  'unclassified-inflow-no-counterparty': ([t]) => {
    expect(t.detailed).toBe('OTHER_OTHER')
    expect(t.counterparties).toEqual([])
    expect(t.expected).toEqual({ kind: 'unclassified_inflow', rule: 6 })
  },
  'pending-included': (rows) => {
    for (const t of rows) {
      expect(t.pending).toBe(true)
      expect(t.expected.kind).toBe('spend')
    }
  },
}

describe('each named case has the property that makes it a trap', () => {
  it('every case in the manifest has its own assertion', () => {
    const missing = ds.cases.map((c) => c.id).filter((id) => !(id in CASE_CHECKS))
    expect(missing).toEqual([])
    const stale = Object.keys(CASE_CHECKS).filter((id) => !ds.cases.some((c) => c.id === id))
    expect(stale).toEqual([])
  })

  it.each(ds.cases.map((c) => [c.id, c.branch, c.role] as const))('%s (%s, %s)', (id) => {
    CASE_CHECKS[id](rowsOf(id))
  })
})

// ── 5. coverage weighting ─────────────────────────────────────────

describe('the untested branches carry the heaviest coverage', () => {
  const rolesOf = (branch: string): CaseRole[] =>
    ds.cases.filter((c) => c.branch === branch).map((c) => c.role)

  it.each(UNTESTED_BRANCHES)('%s has an easy case, a near miss and a wrong claim', (branch) => {
    const roles = rolesOf(branch)
    expect(roles.length, `${branch} cases`).toBeGreaterThanOrEqual(4)
    expect(roles).toContain('easy')
    expect(roles.some((r) => r === 'near-miss-inside' || r === 'near-miss-outside')).toBe(true)
    expect(roles).toContain('wrong-claim')
  })

  it('card-payment pairing and R5 both have near misses on either side', () => {
    for (const branch of ['card-payment-pair', 'card-payment-unpaired']) {
      const roles = rolesOf(branch)
      expect(roles, branch).toContain('near-miss-inside')
      expect(roles, branch).toContain('near-miss-outside')
    }
  })

  it('more cases cover the untested branches than the rest put together', () => {
    const untested = ds.cases.filter((c) => (UNTESTED_BRANCHES as string[]).includes(c.branch)).length
    expect(untested).toBeGreaterThan(ds.cases.length - untested)
  })
})

// ── 6. nothing pairs by accident, on any day the seed might run ───

describe('the only pairs in the seed are the declared ones', () => {
  // Every fifth day across 13 months: covers every month length, every weekday,
  // and the first and last days of a period.
  const dates: Date[] = []
  for (let i = 0; i < 400; i += 5) {
    dates.push(new Date(Date.UTC(2026, 0, 1 + i, 12)))
  }

  it(`holds for all ${dates.length} build dates`, () => {
    for (const date of dates) {
      const built = buildDemoDataset(date)
      const byAmount = indexByAmount(built.transactions)
      const label = date.toISOString().slice(0, 10)

      const ids = built.transactions.map((t) => t.plaidTransactionId)
      expect(new Set(ids).size, label).toBe(ids.length)

      for (const c of built.cases) {
        for (const id of c.txIds) expect(ids, `${label} ${c.id}`).toContain(id)
      }

      for (const t of built.transactions) {
        const c1 = r1Candidates(t, byAmount)
        const c2 = r2Candidates(t, byAmount)
        const where = `${label} ${t.plaidTransactionId}`

        if (t.expected.kind === 'card_payment' && t.expected.rule === 1) {
          expect(c1.length, `${where} R1 candidates`).toBe(1)
          expect(c2.length, `${where} R2 candidates`).toBe(0)
          expect(c1[0].expected).toEqual({ kind: 'card_payment', rule: 1 })
          expect(r1Candidates(c1[0], byAmount).map((x) => x.plaidTransactionId)).toEqual([
            t.plaidTransactionId,
          ])
        } else if (t.expected.kind === 'internal_transfer' && t.expected.rule === 2) {
          expect(c2.length, `${where} R2 candidates`).toBe(1)
          expect(c1.length, `${where} R1 candidates`).toBe(0)
          expect(c2[0].expected).toEqual({ kind: 'internal_transfer', rule: 2 })
          expect(r2Candidates(c2[0], byAmount).map((x) => x.plaidTransactionId)).toEqual([
            t.plaidTransactionId,
          ])
        } else {
          expect(c1.map((x) => x.plaidTransactionId), `${where} unexpected R1 pair`).toEqual([])
          expect(c2.map((x) => x.plaidTransactionId), `${where} unexpected R2 pair`).toEqual([])
        }
      }
    }
  }, 120_000)
})
