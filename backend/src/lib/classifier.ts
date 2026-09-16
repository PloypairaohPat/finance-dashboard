// ─────────────────────────────────────────────────────────────────
//  classifier.ts — the one place that decides what a transaction IS (M7.3).
//
//  Every money figure in the app is supposed to come from here: spend, income,
//  what is a transfer, what is a card payment, what is a refund. The rules, the
//  decisions behind them (D1-D8) and the calibration they came from are in
//  docs/m7.3-classifier.md. This file is the executable form of that document
//  and follows it rule by rule, in order, first match wins.
//
//  Two properties matter as much as correctness:
//
//    1. Every row gets a MECHANISM, not just a verdict. Task 3 has to explain
//       each before/after difference by naming what caused it, so the mechanism
//       is part of the output rather than something reconstructed afterwards.
//    2. It is pure. No Prisma, no clock, no I/O: rows and options in, verdicts
//       out. That is what lets tests/classifier.test.ts check it against the
//       seed's manifest row by row.
//
//  Sign convention (Plaid): positive = money OUT, negative = money IN.
// ─────────────────────────────────────────────────────────────────

import { mapPlaidCategory } from './categoryMap'
import { perPeriodCap, type PeriodFlow, type PeriodSpend } from './paymentApp'

// ── the constants the rules are written against ───────────────────

/** The visible bucket payment-app outflows land in (R4). */
export const PAYMENTS_TO_PEOPLE = 'Payments to people'

/** Gate thresholds, chosen per rule by which way that rule fails (D6). */
export const GATE_HIGH = ['VERY_HIGH', 'HIGH'] as const
export const GATE_MEDIUM = ['VERY_HIGH', 'HIGH', 'MEDIUM'] as const

/**
 * Codes a linked-bank counterparty may exclude on its own (D4). Deliberately
 * excludes TRANSFER_*_OTHER_TRANSFER_*, Plaid's catch-all, and everything that
 * moves real money under a transfer-ish name: withdrawals, deposits, fees.
 */
export const LINKED_BANK_ALLOWLIST = [
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
  'TRANSFER_IN_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_IN_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
] as const

/** Codes the savings exclusion covers (R7, gated HIGH+). */
export const SAVINGS_EXCLUSION_CODES = [
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
] as const

/** Pairing windows in days. R2's 4 is for weekend ACH settlement (D8). */
export const R1_WINDOW_DAYS = 7
export const R2_WINDOW_DAYS = 4

// ── input and output ──────────────────────────────────────────────

export interface Counterparty {
  name?: string | null
  type?: string | null
}

export interface ClassifierTx {
  id: string
  accountId: string
  accountType: string
  /** UTC midnight, or YYYY-MM-DD. */
  date: Date | string
  amount: number
  categoryPrimary: string | null
  categoryDetailed: string | null
  confidence: string | null
  counterparties: Counterparty[]
  pending: boolean
}

export type ClassKind =
  | 'spend'
  | 'income'
  | 'card_payment'
  | 'internal_transfer'
  | 'refund'
  | 'payment_app_in'
  | 'credit_inflow_not_income'
  | 'unclassified_inflow'
  | 'savings_transfer'

/**
 * Why a row was classified the way it was. Task 3 groups before/after
 * differences by these, so every change to a figure has a name.
 */
export type Mechanism =
  | 'card-payment-pair'
  | 'card-payment-unpaired'
  | 'internal-transfer-pair'
  | 'linked-bank-exclusion'
  | 'savings-exclusion'
  | 'refund'
  | 'refund-unallocated'
  | 'credit-inflow-not-income'
  | 'payment-app-out'
  | 'payment-app-in'
  | 'income-definition-c'
  | 'unclassified-inflow'
  | 'ordinary-spend'

export interface Classified {
  id: string
  kind: ClassKind
  /** Which numbered rule decided it (docs/m7.3-classifier.md). */
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7
  mechanism: Mechanism
  /** Display bucket for spend; for a refund, the category it nets against. */
  bucket?: string
  netsAgainst?: string | null
  /** The other leg, for R1 and R2 pairs. */
  partnerId?: string
  /** One line of plain English, for the reconciliation report. */
  reason: string
}

export interface ClassifyOptions {
  /** Institution names the user has linked. */
  linkedInstitutions: string[]
  /** Institutions where a CREDIT account is actually linked (D3). */
  institutionsWithCreditAccount: string[]
  /** Which money period a date belongs to — R4's cap is per period. */
  periodKeyOf: (date: Date) => string
}

export interface ClassificationResult {
  byId: Map<string, Classified>
  /** Per-period payment-app totals, after the cap (D5 option a). */
  paymentApp: PeriodSpend[]
}

// ── helpers ───────────────────────────────────────────────────────

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const cents = (n: number) => Math.round(n * 100)
const asDate = (d: Date | string) => (d instanceof Date ? d : new Date(`${d}T00:00:00.000Z`))
const dayNumber = (d: Date | string) => Math.floor(asDate(d).getTime() / 86_400_000)
const gapDays = (a: ClassifierTx, b: ClassifierTx) => Math.abs(dayNumber(a.date) - dayNumber(b.date))

const isOut = (t: ClassifierTx) => t.amount > 0
const isIn = (t: ClassifierTx) => t.amount < 0
const isDepository = (t: ClassifierTx) => t.accountType === 'depository'
const isCredit = (t: ClassifierTx) => t.accountType === 'credit'

const cpTypes = (t: ClassifierTx) => t.counterparties.map((c) => (c.type ?? '').toLowerCase())
const hasMerchantCp = (t: ClassifierTx) =>
  cpTypes(t).some((ty) => ty === 'merchant' || ty === 'marketplace')
const hasPaymentAppCp = (t: ClassifierTx) => cpTypes(t).includes('payment_app')
/** D2: a leg carrying any of these cannot be half of a card payment. */
const hasVetoCp = (t: ClassifierTx) => hasMerchantCp(t) || hasPaymentAppCp(t)

const detailedOf = (t: ClassifierTx) => (t.categoryDetailed ?? '').toUpperCase()
const primaryOf = (t: ClassifierTx) => (t.categoryPrimary ?? '').toUpperCase()

const gatePasses = (t: ClassifierTx, levels: readonly string[]) =>
  t.confidence !== null && levels.includes(t.confidence.toUpperCase())

export function classify(
  transactions: readonly ClassifierTx[],
  options: ClassifyOptions,
): ClassificationResult {
  const linked = new Set(options.linkedInstitutions.map(normalize))
  const withCredit = new Set(options.institutionsWithCreditAccount.map(normalize))

  const matchesLinkedBank = (t: ClassifierTx) =>
    t.counterparties.some(
      (c) => (c.type ?? '').toLowerCase() === 'financial_institution' && linked.has(normalize(c.name ?? '')),
    )
  const matchesBankWithCard = (t: ClassifierTx) =>
    t.counterparties.some(
      (c) => (c.type ?? '').toLowerCase() === 'financial_institution' && withCredit.has(normalize(c.name ?? '')),
    )
  /** D1: a transfer signal is a transfer code, or the user's own bank named. */
  const hasTransferSignal = (t: ClassifierTx) =>
    /^TRANSFER_(IN|OUT)_/.test(detailedOf(t)) || matchesLinkedBank(t)

  const byId = new Map<string, Classified>()
  const claim = (c: Classified) => byId.set(c.id, c)

  // Deterministic order: date, then id. Pairing must not depend on input order.
  const rows = [...transactions].sort(
    (a, b) => dayNumber(a.date) - dayNumber(b.date) || a.id.localeCompare(b.id),
  )

  // Index inflows by absolute cents so pairing stays linear-ish.
  const inflowsByAmount = new Map<number, ClassifierTx[]>()
  for (const t of rows) {
    if (!isIn(t)) continue
    const k = Math.abs(cents(t.amount))
    const arr = inflowsByAmount.get(k) ?? []
    arr.push(t)
    inflowsByAmount.set(k, arr)
  }
  const candidates = (t: ClassifierTx) => inflowsByAmount.get(Math.abs(cents(t.amount))) ?? []
  /** Nearest unclaimed partner: smallest day gap, then earliest, then id. */
  const nearest = (t: ClassifierTx, eligible: (i: ClassifierTx) => boolean) =>
    candidates(t)
      .filter((i) => !byId.has(i.id) && eligible(i))
      .sort(
        (x, y) =>
          gapDays(t, x) - gapDays(t, y) ||
          dayNumber(x.date) - dayNumber(y.date) ||
          x.id.localeCompare(y.id),
      )[0]

  // ── R1: card payment (pair) ─────────────────────────────────────
  for (const out of rows) {
    if (byId.has(out.id) || !isOut(out) || !isDepository(out) || hasVetoCp(out)) continue
    const partner = nearest(
      out,
      (i) => isCredit(i) && !hasVetoCp(i) && gapDays(out, i) <= R1_WINDOW_DAYS,
    )
    if (!partner) continue
    const reason = `paid off a linked card: matched an exact-amount credit-account inflow ${gapDays(out, partner)} day(s) away`
    claim({ id: out.id, kind: 'card_payment', rule: 1, mechanism: 'card-payment-pair', partnerId: partner.id, reason })
    claim({ id: partner.id, kind: 'card_payment', rule: 1, mechanism: 'card-payment-pair', partnerId: out.id, reason })
  }

  // ── R2: internal transfer (pair) ────────────────────────────────
  for (const out of rows) {
    if (byId.has(out.id) || !isOut(out) || !isDepository(out) || !hasTransferSignal(out)) continue
    const partner = nearest(
      out,
      (i) =>
        isDepository(i) &&
        i.accountId !== out.accountId &&
        hasTransferSignal(i) &&
        gapDays(out, i) <= R2_WINDOW_DAYS,
    )
    if (!partner) continue
    const reason = `moved between the user's own accounts: exact-amount pair ${gapDays(out, partner)} day(s) apart, transfer signal on both legs`
    claim({ id: out.id, kind: 'internal_transfer', rule: 2, mechanism: 'internal-transfer-pair', partnerId: partner.id, reason })
    claim({ id: partner.id, kind: 'internal_transfer', rule: 2, mechanism: 'internal-transfer-pair', partnerId: out.id, reason })
  }

  // ── R3-R7, in order, on whatever is left ────────────────────────
  for (const t of rows) {
    if (byId.has(t.id)) continue
    const detailed = detailedOf(t)
    const primary = primaryOf(t)
    const bucket = mapPlaidCategory(primary)

    // R3 — unpaired credit-account inflow, and (D7) its debit-card twin.
    const isRefundShaped =
      isIn(t) && hasMerchantCp(t) && !primary.startsWith('INCOME') && !primary.startsWith('TRANSFER_IN')
    if (isCredit(t) && isIn(t)) {
      if (hasMerchantCp(t)) {
        const nets = gatePasses(t, GATE_HIGH)
        claim({
          id: t.id, kind: 'refund', rule: 3,
          mechanism: nets ? 'refund' : 'refund-unallocated',
          netsAgainst: nets ? bucket : null,
          reason: nets
            ? `refund from a merchant, netted against ${bucket}`
            : `refund from a merchant, but confidence ${t.confidence ?? 'missing'} is too low to trust the category: reduces total spend only`,
        })
      } else {
        claim({
          id: t.id, kind: 'credit_inflow_not_income', rule: 3, mechanism: 'credit-inflow-not-income',
          reason: 'money onto a credit card with no merchant behind it: not a refund, and a credit inflow is never income',
        })
      }
      continue
    }
    if (isDepository(t) && isRefundShaped) {
      const nets = gatePasses(t, GATE_HIGH)
      claim({
        id: t.id, kind: 'refund', rule: 3,
        mechanism: nets ? 'refund' : 'refund-unallocated',
        netsAgainst: nets ? bucket : null,
        reason: nets
          ? `refund paid back to a bank account, netted against ${bucket} (D7)`
          : `refund paid back to a bank account, category not trusted at confidence ${t.confidence ?? 'missing'} (D7)`,
      })
      continue
    }

    // R4 — payment apps. A merchant counterparty means the app was only a rail.
    if (hasPaymentAppCp(t) && !hasMerchantCp(t)) {
      if (isOut(t)) {
        claim({
          id: t.id, kind: 'spend', rule: 4, mechanism: 'payment-app-out', bucket: PAYMENTS_TO_PEOPLE,
          reason: 'paid a person through a payment app',
        })
      } else {
        claim({
          id: t.id, kind: 'payment_app_in', rule: 4, mechanism: 'payment-app-in',
          reason: 'paid back through a payment app: reduces payments to people, capped at this period\'s outgoing total',
        })
      }
      continue
    }

    // R5 — an unpaired card payment.
    if (isOut(t) && isDepository(t) && detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') {
      if (matchesBankWithCard(t) && gatePasses(t, GATE_HIGH)) {
        claim({
          id: t.id, kind: 'card_payment', rule: 5, mechanism: 'card-payment-unpaired',
          reason: 'card payment to a bank where a card is linked, with no matching inflow synced yet',
        })
      } else {
        claim({
          id: t.id, kind: 'spend', rule: 5, mechanism: 'ordinary-spend', bucket: 'Debt',
          reason: matchesLinkedBank(t)
            ? 'card payment to a bank with no linked card (D3): the only evidence of that card\'s spending, so it counts'
            : 'card payment with nothing to prove it went to a linked card',
        })
      }
      continue
    }

    const allowlisted = (LINKED_BANK_ALLOWLIST as readonly string[]).includes(detailed)

    // R6 — remaining depository inflows.
    if (isIn(t)) {
      if (allowlisted && matchesLinkedBank(t)) {
        // Everything says "internal leg" except the confidence. Failing the gate
        // must not promote it to income — a doubtful transfer would then inflate
        // income and the savings rate (D6).
        if (gatePasses(t, GATE_MEDIUM)) {
          claim({
            id: t.id, kind: 'internal_transfer', rule: 6, mechanism: 'linked-bank-exclusion',
            reason: 'transfer in from the user\'s own bank whose other leg has not synced',
          })
        } else {
          claim({
            id: t.id, kind: 'unclassified_inflow', rule: 6, mechanism: 'unclassified-inflow',
            reason: `looks like a transfer from the user's own bank, but confidence ${t.confidence ?? 'missing'} is too low to say: shown rather than counted as income`,
          })
        }
      } else if (primary.startsWith('INCOME') || primary.startsWith('TRANSFER_IN')) {
        claim({
          id: t.id, kind: 'income', rule: 6, mechanism: 'income-definition-c',
          reason: 'money in that nothing marks as a transfer between the user\'s own accounts',
        })
      } else {
        claim({
          id: t.id, kind: 'unclassified_inflow', rule: 6, mechanism: 'unclassified-inflow',
          reason: 'money in that cannot be identified: shown rather than counted as income',
        })
      }
      continue
    }

    // R7 — everything else is spend, with two exclusions.
    if (allowlisted && matchesLinkedBank(t) && gatePasses(t, GATE_HIGH)) {
      claim({
        id: t.id, kind: 'internal_transfer', rule: 7, mechanism: 'linked-bank-exclusion',
        reason: 'transfer out to the user\'s own bank whose other leg has not synced',
      })
      continue
    }
    if (
      (SAVINGS_EXCLUSION_CODES as readonly string[]).includes(detailed) &&
      !matchesLinkedBank(t) &&
      gatePasses(t, GATE_HIGH)
    ) {
      claim({
        id: t.id, kind: 'savings_transfer', rule: 7, mechanism: 'savings-exclusion',
        reason: 'moved into savings or investments: saved, not spent',
      })
      continue
    }
    claim({
      id: t.id, kind: 'spend', rule: 7, mechanism: 'ordinary-spend', bucket,
      reason: `ordinary spending in ${bucket}`,
    })
  }

  // ── R4's cap, per period (D5 option a) ──────────────────────────
  const flows = new Map<string, PeriodFlow>()
  for (const t of rows) {
    const verdict = byId.get(t.id)
    if (!verdict || verdict.rule !== 4) continue
    const key = options.periodKeyOf(asDate(t.date))
    const flow = flows.get(key) ?? { key, out: 0, in: 0 }
    if (isOut(t)) flow.out = Math.round((flow.out + t.amount) * 100) / 100
    else flow.in = Math.round((flow.in - t.amount) * 100) / 100
    flows.set(key, flow)
  }
  const paymentApp = perPeriodCap([...flows.values()].sort((a, b) => a.key.localeCompare(b.key)))

  return { byId, paymentApp }
}
