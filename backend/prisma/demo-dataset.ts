// ─────────────────────────────────────────────────────────────────
//  demo-dataset.ts — the demo user's data, as a PURE function, plus a
//  manifest of what the M7.3 classifier must decide about every row.
//
//  Why a pure builder and not just a seed script: the seed is now a test
//  fixture as well as a demo. `buildDemoDataset(now)` takes the current time
//  and returns rows + expectations with no database, no clock and no
//  randomness beyond one seeded RNG, so tests/demo-dataset.test.ts can check
//  the fixture itself — and, once the classifier exists (M7.3 task 3), check
//  the classifier against `expected` on every row.
//
//  The shapes come from calibration against real data (docs/m7.3-classifier.md;
//  results are gitignored). Volume is ~85 transactions a month, and the branches
//  real data never exercised get the heaviest coverage: each gets an easy case,
//  near-misses just inside and just outside its boundary, and a case a
//  neighbouring rule would wrongly claim.
//
//  Dates are UTC, because src/lib/period.ts is UTC-only and transaction dates
//  are stored as UTC midnight. Cases live in COMPLETED periods (back 1-5) so
//  they exist no matter which day the seed runs; the current period holds
//  background rows only, truncated at today.
//
//  Sign convention (Plaid): positive = money OUT, negative = money IN.
// ─────────────────────────────────────────────────────────────────

import { mapPlaidCategory } from '../src/lib/categoryMap'

export const DEMO_USER_ID = 'demo-user'
export const MONTHS_OF_HISTORY = 6
export const DEMO_PERIOD_START_DAY = 1

/** The visible bucket payment-app outflows land in (docs/m7.3-classifier.md R4). */
export const PAYMENTS_TO_PEOPLE = 'Payments to people'

/**
 * The gate is per rule, and each rule's threshold follows its failure direction
 * (D6). A rule that REMOVES spend when it fires needs HIGH+, because a wrong
 * exclusion flatters the numbers. A rule whose misfire leaves the money counted
 * — or keeps it out of income — can take MEDIUM+.
 */
export const GATE_HIGH = ['VERY_HIGH', 'HIGH'] as const
export const GATE_MEDIUM = ['VERY_HIGH', 'HIGH', 'MEDIUM'] as const

/** Pairing windows, in days: R1 card payments, R2 internal transfers (D8). */
export const R1_WINDOW_DAYS = 7
export const R2_WINDOW_DAYS = 4

/** Codes a linked-bank counterparty may exclude (D4). Everything else is counted. */
export const LINKED_BANK_ALLOWLIST = [
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
  'TRANSFER_IN_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_IN_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_OUT_OTHER_TRANSFER_OUT',
  'TRANSFER_IN_OTHER_TRANSFER_IN',
] as const

/** Codes the savings exclusion covers (R7, gated). */
export const SAVINGS_EXCLUSION_CODES = [
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
] as const

// ── types ─────────────────────────────────────────────────────────

export type Confidence = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

export type CounterpartyType =
  | 'financial_institution'
  | 'payment_app'
  | 'merchant'
  | 'marketplace'
  | 'payment_terminal'

export interface Counterparty {
  name: string
  type: CounterpartyType
}

export type ItemKey = 'demoBank' | 'northwind'
export type AccountKey = 'checking' | 'savings' | 'card' | 'nwChecking'

export interface DemoItem {
  key: ItemKey
  itemId: string
  institutionId: string
  institutionName: string
}

export interface DemoAccount {
  key: AccountKey
  itemKey: ItemKey
  plaidAccountId: string
  name: string
  officialName: string
  type: 'depository' | 'credit'
  subtype: string
  mask: string
  currentBalance: string
  availableBalance: string
}

/**
 * Decisions this revision of the classifier introduces. A row tagged with one
 * has an `expected` that changes if the decision is reversed — reversing it
 * should fail a named test, not drift silently. See docs/m7.3-classifier.md.
 */
export type DecisionId =
  | 'D1' // R2 needs a transfer signal on BOTH legs (the rent coincidence)
  | 'D2' // R1 refuses legs carrying a merchant/marketplace/payment_app counterparty
  | 'D3' // R5's linked-bank branch needs a linked CREDIT account at that institution
  | 'D4' // linked-bank exclusion is an allowlist of account-transfer codes only
  | 'D5' // payment-app cap is per period, no carry-back
  | 'D6' // the confidence gate, per rule, MEDIUM and up
  | 'D7' // depository refunds (merchant counterparty + spending category)
  | 'D8' // R2's window is 4 days, for weekend ACH settlement

export type Expected =
  | { kind: 'spend'; rule: 4 | 5 | 7; bucket: string }
  | { kind: 'income'; rule: 6 }
  | { kind: 'card_payment'; rule: 1 | 5 }
  | { kind: 'internal_transfer'; rule: 2 | 6 | 7 }
  | { kind: 'refund'; rule: 3; netsAgainst: string | null }
  | { kind: 'payment_app_in'; rule: 4 }
  | { kind: 'credit_inflow_not_income'; rule: 3 }
  | { kind: 'unclassified_inflow'; rule: 6 }
  | { kind: 'savings_transfer'; rule: 7 }

export interface DemoTransaction {
  plaidTransactionId: string
  accountKey: AccountKey
  /** YYYY-MM-DD, UTC. */
  date: string
  amount: number
  name: string
  merchantName: string | null
  primary: string
  detailed: string
  /** null models Plaid omitting the level entirely — the gate must fail closed. */
  confidence: Confidence | null
  counterparties: Counterparty[]
  pending: boolean
  expected: Expected
  decisions: DecisionId[]
}

export type CaseBranch =
  | 'card-payment-pair'
  | 'card-payment-unpaired'
  | 'refund'
  | 'savings-transfer'
  | 'non-card-loan'
  | 'rent-coincidence'
  | 'withdrawal-linked-bank'
  | 'payment-app-cap'
  | 'unclassified-inflow'
  | 'pending'

export type CaseRole = 'easy' | 'near-miss-inside' | 'near-miss-outside' | 'wrong-claim'

export interface DemoCase {
  id: string
  branch: CaseBranch
  role: CaseRole
  note: string
  txIds: string[]
}

/** Branches real data never exercised. These carry the heaviest coverage. */
export const UNTESTED_BRANCHES: CaseBranch[] = [
  'refund',
  'savings-transfer',
  'non-card-loan',
  'rent-coincidence',
  'withdrawal-linked-bank',
]

/** Per-period payment-app totals, stated as literals (D5's cap is arithmetic on these). */
export interface PaymentAppExpectation {
  back: number
  periodKey: string
  out: number
  in: number
  /** out - min(in, out): what "Payments to people" shows as spend. */
  netSpend: number
  /** max(0, in - out): shown as unclassified inflow, never income. */
  surplus: number
}

export interface DemoDataset {
  now: Date
  startDay: number
  items: DemoItem[]
  accounts: DemoAccount[]
  transactions: DemoTransaction[]
  cases: DemoCase[]
  paymentApp: PaymentAppExpectation[]
}

// ── fixed structure ───────────────────────────────────────────────

export const DEMO_ITEMS: DemoItem[] = [
  { key: 'demoBank', itemId: 'demo-item-1', institutionId: 'ins_demo', institutionName: 'Demo Bank' },
  // A second linked institution with NO credit account: D3's test bed, and the
  // other end of the cross-institution transfers.
  { key: 'northwind', itemId: 'demo-item-2', institutionId: 'ins_demo_northwind', institutionName: 'Northwind Bank' },
]

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: 'checking', itemKey: 'demoBank', plaidAccountId: 'demo-acct-checking',
    name: 'Everyday Checking', officialName: 'Demo Bank Everyday Checking',
    type: 'depository', subtype: 'checking', mask: '0000',
    currentBalance: '4200.00', availableBalance: '4200.00',
  },
  {
    key: 'savings', itemKey: 'demoBank', plaidAccountId: 'demo-acct-savings',
    name: 'High-Yield Savings', officialName: 'Demo Bank Savings',
    type: 'depository', subtype: 'savings', mask: '1111',
    currentBalance: '15200.00', availableBalance: '15200.00',
  },
  {
    key: 'card', itemKey: 'demoBank', plaidAccountId: 'demo-acct-card',
    name: 'Rewards Card', officialName: 'Demo Bank Rewards Visa',
    type: 'credit', subtype: 'credit card', mask: '2222',
    currentBalance: '1450.00', availableBalance: '3550.00',
  },
  {
    key: 'nwChecking', itemKey: 'northwind', plaidAccountId: 'demo-acct-nw-checking',
    name: 'Northwind Checking', officialName: 'Northwind Bank Checking',
    type: 'depository', subtype: 'checking', mask: '3333',
    currentBalance: '2600.00', availableBalance: '2600.00',
  },
]

const CP = {
  demoBank: { name: 'Demo Bank', type: 'financial_institution' } as Counterparty,
  /** Different spelling, same normalised name as "Demo Bank" — R5's matching case. */
  demoBankPunctuated: { name: 'DEMO-BANK', type: 'financial_institution' } as Counterparty,
  northwind: { name: 'Northwind Bank', type: 'financial_institution' } as Counterparty,
  venmo: { name: 'Venmo', type: 'payment_app' } as Counterparty,
  zelle: { name: 'Zelle', type: 'payment_app' } as Counterparty,
  amazon: { name: 'Amazon', type: 'marketplace' } as Counterparty,
  fi: (name: string): Counterparty => ({ name, type: 'financial_institution' }),
  merchant: (name: string): Counterparty => ({ name, type: 'merchant' }),
}

const PRIMARIES = [
  'INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BANK_FEES',
  'ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT', 'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE',
  'RENT_AND_UTILITIES', 'TRANSPORTATION', 'TRAVEL', 'OTHER',
]

/** The Plaid primary a detailed code belongs to. Throws on a code we mistyped. */
export function primaryOf(detailed: string): string {
  const hits = PRIMARIES.filter((p) => detailed === p || detailed.startsWith(`${p}_`))
  if (hits.length === 0) throw new Error(`demo-dataset: "${detailed}" has no known Plaid primary`)
  return hits.sort((a, b) => b.length - a.length)[0]
}

// ── helpers ───────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const key = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)

/** Spend in the bucket mapPlaidCategory gives this code (the default, R7). */
const spend = (detailed: string, rule: 4 | 5 | 7 = 7): Expected => ({
  kind: 'spend', rule, bucket: mapPlaidCategory(primaryOf(detailed)),
})
const paymentsToPeople = (): Expected => ({ kind: 'spend', rule: 4, bucket: PAYMENTS_TO_PEOPLE })
const income = (): Expected => ({ kind: 'income', rule: 6 })
const refund = (detailed: string, gatePasses: boolean): Expected => ({
  kind: 'refund', rule: 3, netsAgainst: gatePasses ? mapPlaidCategory(primaryOf(detailed)) : null,
})

interface AddInput {
  slug: string
  day: number
  account: AccountKey
  amount: number
  name: string
  detailed: string
  expected: Expected
  confidence?: Confidence | null
  cps?: Counterparty[]
  merchant?: string | null
  pending?: boolean
  decisions?: DecisionId[]
}

// ── the builder ───────────────────────────────────────────────────

export function buildDemoDataset(now: Date): DemoDataset {
  const rnd = mulberry32(20260825)
  const between = (min: number, max: number) => round2(min + rnd() * (max - min))
  const day1to28 = () => 1 + Math.floor(rnd() * 28)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]

  const transactions: DemoTransaction[] = []
  const cases: DemoCase[] = []
  const paymentApp: PaymentAppExpectation[] = []

  const groceryMerchants = ['WHOLE FOODS', "TRADER JOE'S", 'SAFEWAY', 'COSTCO']
  const diningMerchants = ['CHIPOTLE', 'SWEETGREEN', 'SHAKE SHACK', 'LOCAL THAI', 'MOMOFUKU']
  const coffeeMerchants = ['STARBUCKS', 'BLUE BOTTLE', 'PHILZ COFFEE']
  const gasMerchants = ['SHELL', 'CHEVRON', 'ARCO']
  const shopMerchants = ['TARGET', 'UNIQLO', 'BEST BUY']
  const otherMerchants = ['SQ *CORNER DELI', 'PAYPAL *ETSY SHOP', 'TST* WINE BAR', 'SP DOGWOOD GOODS']
  const mixedConfidence: Confidence[] = ['VERY_HIGH', 'VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW']

  const cardPaymentAmounts = [812.34, 1045.67, 933.1, 1120.45, 876.21, 701.88] // index = back

  for (let back = MONTHS_OF_HISTORY - 1; back >= 0; back--) {
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth() - back
    const monthStart = new Date(Date.UTC(y, m, 1))
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    const isCurrent = back === 0
    const lastDay = isCurrent ? now.getUTCDate() : daysInMonth
    const monthKey = monthStart.toISOString().slice(0, 7)
    const periodKey = `${monthKey}-01`

    const add = (input: AddInput): string | null => {
      if (input.day > lastDay) return null
      const id = `demo-${monthKey}-${input.slug}`
      transactions.push({
        plaidTransactionId: id,
        accountKey: input.account,
        date: key(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), input.day),
        amount: round2(input.amount),
        name: input.name,
        merchantName: input.merchant ?? null,
        primary: primaryOf(input.detailed),
        detailed: input.detailed,
        confidence: input.confidence === undefined ? 'HIGH' : input.confidence,
        counterparties: input.cps ?? [],
        pending: input.pending ?? false,
        expected: input.expected,
        decisions: input.decisions ?? [],
      })
      return id
    }

    const addCase = (id: string, branch: CaseBranch, role: CaseRole, note: string, txIds: Array<string | null>) => {
      const ids = txIds.filter((t): t is string => t !== null)
      if (ids.length !== txIds.length) return // an incomplete case is no case
      cases.push({ id, branch, role, note, txIds: ids })
    }

    // ── background: income ──────────────────────────────────────
    const pay1 = between(2400, 2500)
    const pay2 = between(2400, 2500)
    add({
      slug: 'payroll-1', day: 1, account: 'checking', amount: -pay1,
      name: 'BRIGHTLINE PAYROLL DIRECT DEP', detailed: 'INCOME_SALARY',
      confidence: 'VERY_HIGH', expected: income(),
    })
    // In one month payroll carries a merchant counterparty: D7 must not read a
    // salary as a refund just because a merchant is named.
    const payroll2 = add({
      slug: 'payroll-2', day: 15, account: 'checking', amount: -pay2,
      name: 'BRIGHTLINE PAYROLL DIRECT DEP', detailed: 'INCOME_SALARY',
      confidence: 'VERY_HIGH',
      cps: back === 2 ? [CP.merchant('Brightline Payroll')] : [],
      expected: income(), decisions: back === 2 ? ['D7'] : [],
    })
    if (back === 2) {
      addCase('payroll-merchant-counterparty', 'refund', 'wrong-claim',
        'salary with a merchant counterparty stays income — D7 excludes INCOME_* codes', [payroll2])
    }

    // Interest paid by the user's own bank: an INCOME code with a linked-bank
    // counterparty. The D4 allowlist must leave it alone.
    const interest = add({
      slug: 'interest', day: 28, account: 'savings', amount: -between(8, 15),
      name: 'INTEREST PAYMENT', detailed: 'INCOME_INTEREST_EARNED',
      confidence: 'HIGH', cps: [CP.demoBank], expected: income(), decisions: ['D4'],
    })
    if (back === 2) {
      addCase('interest-linked-bank', 'withdrawal-linked-bank', 'wrong-claim',
        'interest from your own bank is income, not an internal transfer', [interest])
    }

    // ── background: housing and bills ───────────────────────────
    const rent = add({
      slug: 'rent', day: 1, account: 'checking', amount: 1650,
      name: 'GREYSTONE APARTMENTS', detailed: 'RENT_AND_UTILITIES_RENT',
      merchant: 'Greystone Apartments', cps: [CP.merchant('Greystone Apartments')],
      expected: spend('RENT_AND_UTILITIES_RENT'),
    })
    add({
      slug: 'electric', day: 8, account: 'checking', amount: between(84, 132),
      name: 'CITY POWER & LIGHT', detailed: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
      merchant: 'City Power & Light', cps: [CP.merchant('City Power & Light')],
      confidence: 'VERY_HIGH', expected: spend('RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'),
    })
    add({
      slug: 'internet', day: 10, account: 'checking', amount: 69.99,
      name: 'XFINITY INTERNET', detailed: 'RENT_AND_UTILITIES_INTERNET_AND_CABLE',
      merchant: 'Xfinity', cps: [CP.merchant('Xfinity')],
      confidence: 'VERY_HIGH', expected: spend('RENT_AND_UTILITIES_INTERNET_AND_CABLE'),
    })
    add({
      slug: 'phone', day: 12, account: 'checking', amount: 55,
      name: 'T-MOBILE', detailed: 'RENT_AND_UTILITIES_TELEPHONE',
      merchant: 'T-Mobile', cps: [CP.merchant('T-Mobile')],
      confidence: 'VERY_HIGH', expected: spend('RENT_AND_UTILITIES_TELEPHONE'),
    })
    add({
      slug: 'insurance', day: 20, account: 'checking', amount: 142.5,
      name: 'GEICO AUTO', detailed: 'GENERAL_SERVICES_INSURANCE',
      merchant: 'Geico', cps: [CP.merchant('Geico')],
      expected: spend('GENERAL_SERVICES_INSURANCE'),
    })

    // ── background: subscriptions (recurring.service.ts mirrors these) ──
    add({
      slug: 'sub-icloud', day: 2, account: 'card', amount: 2.99, name: 'ICLOUD+',
      detailed: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES', merchant: 'Apple iCloud',
      cps: [CP.merchant('Apple')], confidence: 'VERY_HIGH',
      expected: spend('GENERAL_SERVICES_OTHER_GENERAL_SERVICES'),
    })
    add({
      slug: 'sub-netflix', day: 3, account: 'card', amount: 15.49, name: 'NETFLIX',
      detailed: 'ENTERTAINMENT_TV_AND_MOVIES', merchant: 'Netflix',
      cps: [CP.merchant('Netflix')], confidence: 'VERY_HIGH',
      expected: spend('ENTERTAINMENT_TV_AND_MOVIES'),
    })
    add({
      slug: 'sub-spotify', day: 5, account: 'card', amount: 11.99, name: 'SPOTIFY',
      detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO', merchant: 'Spotify',
      cps: [CP.merchant('Spotify')], confidence: 'VERY_HIGH',
      expected: spend('ENTERTAINMENT_MUSIC_AND_AUDIO'),
    })
    add({
      slug: 'sub-gym', day: 6, account: 'card', amount: 39, name: 'CROSSFIT DOWNTOWN',
      detailed: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', merchant: 'CrossFit Downtown',
      cps: [CP.merchant('CrossFit Downtown')], confidence: 'VERY_HIGH',
      expected: spend('PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
    })

    // ── background: everyday spending ───────────────────────────
    ;[4, 9, 14, 19, 24].forEach((d, i) => {
      const amount = between(52, 148)
      const merchant = pick(groceryMerchants)
      add({
        slug: `grocery-${i + 1}`, day: d, account: i % 2 === 0 ? 'checking' : 'card',
        amount, name: merchant, detailed: 'FOOD_AND_DRINK_GROCERIES',
        merchant, cps: [CP.merchant(merchant)], confidence: 'VERY_HIGH',
        expected: spend('FOOD_AND_DRINK_GROCERIES'),
      })
    })
    for (let i = 0; i < 12; i++) {
      const d = day1to28()
      const amount = between(8, 54)
      const merchant = pick(diningMerchants)
      const confidence = pick(mixedConfidence)
      add({
        slug: `dining-${i + 1}`, day: d, account: 'card', amount, name: merchant,
        detailed: 'FOOD_AND_DRINK_RESTAURANT', merchant, cps: [CP.merchant(merchant)],
        confidence, expected: spend('FOOD_AND_DRINK_RESTAURANT'),
      })
    }
    for (let i = 0; i < 8; i++) {
      const d = day1to28()
      const amount = between(4, 8)
      const merchant = pick(coffeeMerchants)
      add({
        slug: `coffee-${i + 1}`, day: d, account: 'card', amount, name: merchant,
        detailed: 'FOOD_AND_DRINK_COFFEE', merchant, cps: [CP.merchant(merchant)],
        confidence: 'VERY_HIGH', expected: spend('FOOD_AND_DRINK_COFFEE'),
      })
    }
    ;[7, 17, 27].forEach((d, i) => {
      const amount = between(32, 61)
      const merchant = pick(gasMerchants)
      add({
        slug: `gas-${i + 1}`, day: d, account: 'checking', amount, name: merchant,
        detailed: 'TRANSPORTATION_GAS', merchant, cps: [CP.merchant(merchant)],
        confidence: 'VERY_HIGH', expected: spend('TRANSPORTATION_GAS'),
      })
    })
    ;[9, 16, 23].forEach((d, i) => {
      const amount = between(11, 33)
      add({
        slug: `ride-${i + 1}`, day: d, account: 'card', amount, name: 'UBER TRIP',
        detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES', merchant: 'Uber',
        cps: [CP.merchant('Uber')], confidence: pick(mixedConfidence),
        expected: spend('TRANSPORTATION_TAXIS_AND_RIDE_SHARES'),
      })
    })
    for (let i = 0; i < 4; i++) {
      const d = day1to28()
      const amount = between(24, 190)
      add({
        slug: `market-${i + 1}`, day: d, account: 'card', amount, name: 'AMAZON MKTPLACE',
        detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', merchant: 'Amazon',
        cps: [CP.amazon], confidence: pick(mixedConfidence),
        expected: spend('GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'),
      })
    }
    {
      const amount = between(30, 120)
      const merchant = pick(shopMerchants)
      add({
        slug: 'clothing', day: 13, account: 'card', amount, name: merchant,
        detailed: 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', merchant,
        cps: [CP.merchant(merchant)], confidence: pick(mixedConfidence),
        expected: spend('GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES'),
      })
    }
    // OTHER_OTHER outflows with a merchant counterparty and no merchant_name —
    // the single largest uncategorised shape in the calibrated data.
    for (let i = 0; i < 5; i++) {
      const d = day1to28()
      const amount = between(12, 90)
      const merchant = pick(otherMerchants)
      add({
        slug: `other-debit-${i + 1}`, day: d, account: 'checking', amount, name: merchant,
        detailed: 'OTHER_OTHER', cps: [CP.merchant(merchant)], confidence: pick(mixedConfidence),
        expected: spend('OTHER_OTHER'),
      })
    }
    for (let i = 0; i < 3; i++) {
      const d = day1to28()
      const amount = between(10, 70)
      const merchant = pick(otherMerchants)
      add({
        slug: `other-credit-${i + 1}`, day: d, account: 'card', amount, name: merchant,
        detailed: 'OTHER_OTHER', cps: [CP.merchant(merchant)], confidence: pick(mixedConfidence),
        expected: spend('OTHER_OTHER'),
      })
    }
    {
      const amount = between(14, 68)
      add({
        slug: 'entertainment', day: 21, account: 'card', amount, name: 'AMC THEATRES',
        detailed: 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS',
        merchant: 'AMC Theatres', cps: [CP.merchant('AMC Theatres')], confidence: 'VERY_HIGH',
        expected: spend('ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS'),
      })
    }
    {
      const amount = between(25, 60)
      add({
        slug: 'haircut', day: 11, account: 'checking', amount, name: 'SHEARWATER SALON',
        detailed: 'PERSONAL_CARE_HAIR_AND_BEAUTY', merchant: 'Shearwater Salon',
        cps: [CP.merchant('Shearwater Salon')], confidence: 'HIGH',
        expected: spend('PERSONAL_CARE_HAIR_AND_BEAUTY'),
      })
    }

    // ── background: the non-card loan (a branch real data never had) ──
    const carPayment = add({
      slug: 'car-loan', day: 18, account: 'checking', amount: 385.2,
      name: 'SUMMIT AUTO FINANCE PMT', detailed: 'LOAN_PAYMENTS_CAR_PAYMENT',
      cps: [CP.fi('Summit Auto Finance')],
      confidence: back === 3 ? 'LOW' : 'HIGH',
      expected: spend('LOAN_PAYMENTS_CAR_PAYMENT'),
    })
    if (back === 1) {
      addCase('loan-car-easy', 'non-card-loan', 'easy',
        'a car payment is spend (Debt) — only CARD payments are excluded', [carPayment])
    }
    if (back === 3) {
      addCase('loan-car-low-confidence', 'non-card-loan', 'near-miss-inside',
        'LOW confidence changes nothing: no gated rule applies to an ordinary loan payment', [carPayment])
    }

    // ── background: the monthly card payment (R1's easy pair) ───
    const cardPaymentAmount = cardPaymentAmounts[back]
    // Calibration: card-payment legs are coded inconsistently on both sides, so
    // the pair must be found structurally, not by category.
    const outDetailed = back === 3 ? 'TRANSFER_OUT_ACCOUNT_TRANSFER' : 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    const inDetailed =
      back === 4 ? 'INCOME_OTHER_INCOME'
      : back === 3 ? 'OTHER_OTHER'
      : back === 2 ? 'TRANSFER_IN_ACCOUNT_TRANSFER'
      : 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    const cpOut = add({
      slug: 'card-payment-out', day: 10, account: 'checking', amount: cardPaymentAmount,
      name: 'DEMO BANK CARD PAYMENT', detailed: outDetailed, cps: [CP.demoBank],
      confidence: back === 3 ? 'MEDIUM' : 'HIGH',
      expected: { kind: 'card_payment', rule: 1 },
    })
    const cpIn = add({
      // Same day in the current period, so a truncated month never leaves half a pair.
      slug: 'card-payment-in', day: isCurrent ? 10 : 12, account: 'card', amount: -cardPaymentAmount,
      name: 'PAYMENT THANK YOU', detailed: inDetailed, cps: [],
      confidence: back === 3 ? 'LOW' : 'HIGH',
      expected: { kind: 'card_payment', rule: 1 },
    })
    if (back === 1) {
      addCase('card-payment-pair-easy', 'card-payment-pair', 'easy',
        'exact amount, 2 days apart, categories disagree on both legs', [cpOut, cpIn])
    }

    // ── background: the monthly savings transfer (R2's easy pair) ──
    if (back !== 1) {
      add({
        slug: 'savings-out', day: 16, account: 'checking', amount: 300,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
      add({
        slug: 'savings-in', day: 16, account: 'savings', amount: -300,
        name: 'TRANSFER FROM CHECKING', detailed: 'TRANSFER_IN_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
    }

    // ── background: payment apps ────────────────────────────────
    const payAppOut = [
      { day: 4, amount: 25, account: 'checking' as AccountKey, detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER', cp: CP.venmo, name: 'VENMO PAYMENT' },
      { day: 9, amount: 40, account: 'checking' as AccountKey, detailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS', cp: CP.zelle, name: 'ZELLE TO J RIVERA' },
      { day: 13, amount: 60, account: 'checking' as AccountKey, detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER', cp: CP.venmo, name: 'VENMO PAYMENT' },
      { day: 17, amount: 18.5, account: 'card' as AccountKey, detailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS', cp: CP.venmo, name: 'VENMO PAYMENT' },
      { day: 22, amount: 32, account: 'checking' as AccountKey, detailed: 'OTHER_OTHER', cp: CP.venmo, name: 'VENMO' },
      { day: 26, amount: 75, account: 'checking' as AccountKey, detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER', cp: CP.venmo, name: 'VENMO PAYMENT' },
    ]
    const payAppIn = [
      { day: 2, amount: 12.5, detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', confidence: 'HIGH' as Confidence },
      { day: 6, amount: 20, detailed: 'OTHER_OTHER', confidence: 'LOW' as Confidence },
      { day: 8, amount: 30, detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', confidence: 'HIGH' as Confidence },
      { day: 11, amount: 9.25, detailed: 'OTHER_OTHER', confidence: 'LOW' as Confidence },
      { day: 15, amount: 16, detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', confidence: 'MEDIUM' as Confidence },
      { day: 19, amount: 37.5, detailed: 'OTHER_OTHER', confidence: 'HIGH' as Confidence },
      { day: 21, amount: 45, detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', confidence: 'HIGH' as Confidence },
      { day: 24, amount: 22, detailed: 'OTHER_OTHER', confidence: 'LOW' as Confidence },
      { day: 27, amount: 15, detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', confidence: 'HIGH' as Confidence },
    ]
    const payAppIds: string[] = []
    payAppOut.forEach((p, i) => {
      const id = add({
        slug: `payapp-out-${i + 1}`, day: p.day, account: p.account, amount: p.amount,
        name: p.name, detailed: p.detailed, cps: [p.cp], confidence: 'HIGH',
        expected: paymentsToPeople(),
      })
      if (id) payAppIds.push(id)
    })
    payAppIn.forEach((p, i) => {
      const id = add({
        slug: `payapp-in-${i + 1}`, day: p.day, account: 'checking', amount: -p.amount,
        name: 'VENMO CASHOUT', detailed: p.detailed, cps: [CP.venmo], confidence: p.confidence,
        expected: { kind: 'payment_app_in', rule: 4 },
      })
      if (id) payAppIds.push(id)
    })

    // Period-shaped payment-app cases (D5). Literal totals below.
    if (back === 4) {
      const id = add({
        slug: 'payapp-in-surplus', day: 12, account: 'checking', amount: -120,
        name: 'VENMO CASHOUT', detailed: 'OTHER_OTHER', cps: [CP.venmo], confidence: 'LOW',
        expected: { kind: 'payment_app_in', rule: 4 },
      })
      if (id) payAppIds.push(id)
      addCase('payment-app-cap-surplus', 'payment-app-cap', 'near-miss-outside',
        'inflows exceed this period\'s payment-app outflows: the cap binds and the surplus is shown as unclassified', [id])
    }
    if (back === 3) {
      const id = add({
        slug: 'payapp-out-boundary', day: daysInMonth, account: 'checking', amount: 80,
        name: 'VENMO PAYMENT', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER', cps: [CP.venmo],
        confidence: 'HIGH', expected: paymentsToPeople(),
      })
      if (id) payAppIds.push(id)
      addCase('payment-app-cap-boundary-out', 'payment-app-cap', 'wrong-claim',
        'paid on the last day of the period; the repayment lands in the NEXT period and never comes back (D5)', [id])
    }
    if (back === 2) {
      const id = add({
        slug: 'payapp-in-boundary', day: 3, account: 'checking', amount: -80,
        name: 'VENMO CASHOUT', detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', cps: [CP.venmo],
        confidence: 'HIGH', expected: { kind: 'payment_app_in', rule: 4 },
      })
      if (id) payAppIds.push(id)
      addCase('payment-app-cap-boundary-in', 'payment-app-cap', 'wrong-claim',
        'the repayment for last period\'s payment: nets here, or is surplus — never against the period that paid', [id])
    }
    if (back === 1) {
      const inId = add({
        slug: 'payapp-in-early', day: 3, account: 'checking', amount: -50,
        name: 'VENMO CASHOUT', detailed: 'TRANSFER_IN_TRANSFER_IN_FROM_APPS', cps: [CP.venmo],
        confidence: 'HIGH', expected: { kind: 'payment_app_in', rule: 4 },
      })
      const outId = add({
        slug: 'payapp-out-late', day: 20, account: 'checking', amount: 50,
        name: 'VENMO PAYMENT', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER', cps: [CP.venmo],
        confidence: 'HIGH', expected: paymentsToPeople(),
      })
      if (inId) payAppIds.push(inId)
      if (outId) payAppIds.push(outId)
      addCase('payment-app-cap-order', 'payment-app-cap', 'near-miss-inside',
        'repayment arrives BEFORE the payment, same period: the cap is on totals, so order is irrelevant', [inId, outId])
    }
    if (back === 5) {
      addCase('payment-app-cap-net', 'payment-app-cap', 'easy',
        'ordinary period: inflows are under the outflow total, so they net inside the bucket', payAppIds.slice(0, 1))
    }

    if (!isCurrent) {
      const outTotal = round2(
        payAppOut.reduce((s, p) => s + p.amount, 0) +
          (back === 3 ? 80 : 0) + (back === 1 ? 50 : 0),
      )
      const inTotal = round2(
        payAppIn.reduce((s, p) => s + p.amount, 0) +
          (back === 4 ? 120 : 0) + (back === 2 ? 80 : 0) + (back === 1 ? 50 : 0),
      )
      paymentApp.push({
        back, periodKey, out: outTotal, in: inTotal,
        netSpend: round2(outTotal - Math.min(inTotal, outTotal)),
        surplus: round2(Math.max(0, inTotal - outTotal)),
      })
    }

    // ── cases: R1 boundaries (card-payment pairing) ─────────────
    if (back === 3) {
      const a = add({
        slug: 'r1-7day-out', day: 3, account: 'checking', amount: 400,
        name: 'ONLINE PAYMENT TO CARD', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'card_payment', rule: 1 },
      })
      const b = add({
        slug: 'r1-7day-in', day: 10, account: 'card', amount: -400,
        name: 'PAYMENT THANK YOU', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'card_payment', rule: 1 },
      })
      addCase('r1-window-inside-7-days', 'card-payment-pair', 'near-miss-inside',
        'exactly 7 days apart: still one card payment', [a, b])

      const c = add({
        slug: 'r1-8day-out', day: 14, account: 'checking', amount: 425,
        name: 'ONLINE PAYMENT TO CARD', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      const d = add({
        slug: 'r1-8day-in', day: 22, account: 'card', amount: -425,
        name: 'PAYMENT THANK YOU', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'credit_inflow_not_income', rule: 3 },
      })
      addCase('r1-window-outside-8-days', 'card-payment-pair', 'near-miss-outside',
        '8 days apart: no pair. The outflow falls to R5 (no linked counterparty, so spend) and the inflow to R3', [c, d])

      const e = add({
        slug: 'r3-cashback', day: 6, account: 'card', amount: -25,
        name: 'CASHBACK REWARD', detailed: 'INCOME_OTHER_INCOME', cps: [CP.demoBank],
        confidence: 'MEDIUM', expected: { kind: 'credit_inflow_not_income', rule: 3 },
      })
      addCase('refund-bank-counterparty-not-income', 'refund', 'near-miss-outside',
        'a credit inflow from the bank itself is not a refund and never income', [e])

      const f = add({
        slug: 'refund-merchant-type', day: 15, account: 'card', amount: -34.5,
        name: 'LOCAL THAI REFUND', detailed: 'FOOD_AND_DRINK_RESTAURANT',
        cps: [CP.merchant('Local Thai')], confidence: 'VERY_HIGH',
        expected: refund('FOOD_AND_DRINK_RESTAURANT', true),
      })
      addCase('refund-merchant-counterparty', 'refund', 'easy',
        'merchant counterparty on a credit inflow: a refund, netted against its own category', [f])

      const g = add({
        slug: 'refund-debit', day: 26, account: 'checking', amount: -52.3,
        name: 'REI REFUND', detailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS',
        cps: [CP.merchant('REI')], confidence: 'HIGH',
        expected: refund('GENERAL_MERCHANDISE_SPORTING_GOODS', true), decisions: ['D7'],
      })
      addCase('refund-on-debit-card', 'refund', 'near-miss-inside',
        'D7: the same refund paid back to checking, which R6 would otherwise file as unclassified', [g])
    }

    if (back === 2) {
      const a = add({
        slug: 'r1-cent-under-out', day: 5, account: 'checking', amount: 510,
        name: 'ONLINE PAYMENT TO CARD', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      const b = add({
        slug: 'r1-cent-under-in', day: 6, account: 'card', amount: -509.99,
        name: 'PAYMENT THANK YOU', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'credit_inflow_not_income', rule: 3 },
      })
      addCase('r1-amount-one-cent-under', 'card-payment-pair', 'near-miss-outside',
        'one cent short of the payment: no pair, because the tolerance is exact', [a, b])

      const c = add({
        slug: 'r1-cent-over-out', day: 16, account: 'checking', amount: 530,
        name: 'ONLINE PAYMENT TO CARD', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      const d = add({
        slug: 'r1-cent-over-in', day: 17, account: 'card', amount: -530.01,
        name: 'PAYMENT THANK YOU', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        expected: { kind: 'credit_inflow_not_income', rule: 3 },
      })
      addCase('r1-amount-one-cent-over', 'card-payment-pair', 'near-miss-outside',
        'one cent over: no pair either — the near-miss is symmetric', [c, d])

      const e = add({
        slug: 'd2-debit-purchase', day: 20, account: 'checking', amount: 45,
        name: 'REI CO-OP', detailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS', merchant: 'REI',
        cps: [CP.merchant('REI')], confidence: 'VERY_HIGH',
        expected: spend('GENERAL_MERCHANDISE_SPORTING_GOODS'), decisions: ['D2'],
      })
      const f = add({
        slug: 'd2-card-refund', day: 22, account: 'card', amount: -45,
        name: 'REI CO-OP REFUND', detailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS',
        cps: [CP.merchant('REI')], confidence: 'HIGH',
        expected: refund('GENERAL_MERCHANDISE_SPORTING_GOODS', true), decisions: ['D2'],
      })
      addCase('r1-wrong-claim-refund', 'card-payment-pair', 'wrong-claim',
        'a $45 debit purchase and a $45 card refund 2 days apart: R1 would pair them without D2', [e, f])

      const g = add({
        slug: 'refund-medium', day: 11, account: 'card', amount: -27.8,
        name: 'UNIQLO REFUND', detailed: 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES',
        cps: [CP.merchant('Uniqlo')], confidence: 'MEDIUM',
        expected: refund('GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', false), decisions: ['D6'],
      })
      addCase('refund-gate-outside-medium', 'refund', 'near-miss-outside',
        'netting removes spend from a named category, so it needs HIGH+: at MEDIUM the refund stays unallocated', [g])

      const h = add({
        slug: 'unclassified-inflow', day: 17, account: 'checking', amount: -40,
        name: 'DEPOSIT', detailed: 'OTHER_OTHER', cps: [], confidence: 'LOW',
        expected: { kind: 'unclassified_inflow', rule: 6 },
      })
      addCase('unclassified-inflow-no-counterparty', 'unclassified-inflow', 'easy',
        'an uncategorised inflow with no counterparty: shown as unclassified, never income', [h])
    }

    // ── cases: R5 boundaries (unpaired card payments) ───────────
    if (back === 4) {
      const linked = add({
        slug: 'r5-linked', day: 5, account: 'checking', amount: 275,
        name: 'DEMO BANK CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.demoBank], confidence: 'HIGH', expected: { kind: 'card_payment', rule: 5 },
      })
      addCase('r5-linked-bank-with-credit', 'card-payment-unpaired', 'easy',
        'unpaired, but the counterparty is a linked bank where a card IS linked', [linked])

      const punctuated = add({
        slug: 'r5-name-normalised', day: 7, account: 'checking', amount: 285,
        name: 'CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.demoBankPunctuated], confidence: 'HIGH', expected: { kind: 'card_payment', rule: 5 },
      })
      addCase('r5-institution-name-normalised', 'card-payment-unpaired', 'near-miss-inside',
        '"DEMO-BANK, N.A." normalises onto "Demo Bank"', [punctuated])

      const medium = add({
        slug: 'r5-medium', day: 9, account: 'checking', amount: 295,
        name: 'DEMO BANK CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.demoBank], confidence: 'MEDIUM',
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' }, decisions: ['D6'],
      })
      addCase('r5-gate-outside-medium', 'card-payment-unpaired', 'near-miss-outside',
        'excluding a card payment removes spend, so it needs HIGH+: MEDIUM is counted', [medium])

      const noCard = add({
        slug: 'r5-no-linked-card', day: 11, account: 'nwChecking', amount: 190,
        name: 'CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.northwind], confidence: 'HIGH',
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' }, decisions: ['D3'],
      })
      addCase('r5-linked-bank-without-credit', 'card-payment-unpaired', 'near-miss-outside',
        'D3: Northwind is linked but no Northwind card is — paying that card is real spending', [noCard])

      const issuer = add({
        slug: 'r5-unlinked-issuer', day: 13, account: 'checking', amount: 320,
        name: 'CRESTLINE CARD SVCS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.fi('Crestline Card Services')], confidence: 'HIGH',
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      addCase('r5-unlinked-issuer', 'card-payment-unpaired', 'near-miss-outside',
        'the real user-2 shape: a card payment to an issuer that is not linked at all', [issuer])

      const noCp = add({
        slug: 'r5-no-counterparty', day: 15, account: 'checking', amount: 150,
        name: 'CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', cps: [],
        confidence: 'HIGH', expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      addCase('r5-no-counterparty', 'card-payment-unpaired', 'near-miss-outside',
        'no counterparty at all: nothing proves the destination, so it stays spend', [noCp])

      const wrongType = add({
        slug: 'r5-wrong-cp-type', day: 17, account: 'checking', amount: 165,
        name: 'DEMO BANK', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.merchant('Demo Bank')], confidence: 'HIGH',
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' },
      })
      addCase('r5-counterparty-wrong-type', 'card-payment-unpaired', 'near-miss-outside',
        'the right name with type "merchant" is not a financial institution', [wrongType])

      const low = add({
        slug: 'r5-low', day: 19, account: 'checking', amount: 180,
        name: 'DEMO BANK CARD PAYMENT', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        cps: [CP.demoBank], confidence: 'LOW',
        expected: { kind: 'spend', rule: 5, bucket: 'Debt' }, decisions: ['D6'],
      })
      addCase('r5-gate-outside-low', 'card-payment-unpaired', 'near-miss-outside',
        'LOW confidence: the code is the only claim it is a card payment, so it is counted', [low])

      const missing = add({
        slug: 'refund-missing-confidence', day: 9, account: 'card', amount: -19.99,
        name: 'TARGET REFUND', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
        cps: [CP.merchant('Target')], confidence: null,
        expected: refund('GENERAL_MERCHANDISE_SUPERSTORES', false), decisions: ['D6'],
      })
      addCase('refund-gate-missing-confidence', 'refund', 'near-miss-outside',
        'no confidence level at all fails the gate: still a refund, but unallocated', [missing])

      const noCpRefund = add({
        slug: 'refund-no-counterparty', day: 23, account: 'card', amount: -48,
        name: 'MERCHANDISE CREDIT', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
        cps: [], confidence: 'HIGH', expected: { kind: 'credit_inflow_not_income', rule: 3 },
      })
      addCase('refund-needs-a-counterparty', 'refund', 'near-miss-outside',
        'a refund-shaped category with no merchant counterparty is not treated as a refund', [noCpRefund])

      const debit61 = add({
        slug: 'd2-debit-61', day: 5, account: 'checking', amount: 61,
        name: 'REI CO-OP', detailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS', merchant: 'REI',
        cps: [CP.merchant('REI')], confidence: 'VERY_HIGH',
        expected: spend('GENERAL_MERCHANDISE_SPORTING_GOODS'), decisions: ['D2'],
      })
      const credit61 = add({
        slug: 'd2-statement-credit', day: 7, account: 'card', amount: -61,
        name: 'STATEMENT CREDIT', detailed: 'OTHER_OTHER', cps: [], confidence: 'LOW',
        expected: { kind: 'credit_inflow_not_income', rule: 3 }, decisions: ['D2'],
      })
      addCase('r1-wrong-claim-statement-credit', 'card-payment-pair', 'wrong-claim',
        'D2 blocks the merchant-counterparty leg, so a statement credit cannot swallow a real purchase', [debit61, credit61])
    }

    // ── cases: savings transfers ────────────────────────────────
    if (back === 1) {
      const a = add({
        slug: 'savings-pair-out', day: 16, account: 'checking', amount: 500,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
      const b = add({
        slug: 'savings-pair-in', day: 16, account: 'savings', amount: -500,
        name: 'TRANSFER FROM CHECKING', detailed: 'TRANSFER_IN_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
      addCase('savings-pair-easy', 'savings-transfer', 'easy',
        'both legs synced: an internal transfer, not savings and not spend', [a, b])

      const inv = add({
        slug: 'savings-investment', day: 26, account: 'checking', amount: 400,
        name: 'FIDELITY TRANSFER', detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
        cps: [CP.fi('Fidelity')], confidence: 'HIGH',
        expected: { kind: 'savings_transfer', rule: 7 }, decisions: ['D6'],
      })
      addCase('savings-investment-code', 'savings-transfer', 'near-miss-inside',
        'money moved to an unlinked brokerage is saved, not spent', [inv])
    }
    if (back === 2) {
      const high = add({
        slug: 'savings-unpaired-high', day: 25, account: 'checking', amount: 250,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        confidence: 'HIGH', expected: { kind: 'savings_transfer', rule: 7 },
      })
      addCase('savings-unpaired', 'savings-transfer', 'easy',
        'savings account not linked, so no second leg exists: excluded from spend', [high])
    }
    if (back === 3) {
      const med = add({
        slug: 'savings-unpaired-medium', day: 24, account: 'checking', amount: 175,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        confidence: 'MEDIUM', expected: spend('TRANSFER_OUT_SAVINGS'), decisions: ['D6'],
      })
      addCase('savings-gate-outside-medium', 'savings-transfer', 'near-miss-outside',
        'the savings exclusion removes spend, so it needs HIGH+: at MEDIUM the transfer is counted', [med])

      const a = add({
        slug: 'savings-3day-out', day: 8, account: 'checking', amount: 360,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
      const b = add({
        slug: 'savings-3day-in', day: 11, account: 'savings', amount: -360,
        name: 'TRANSFER FROM CHECKING', detailed: 'TRANSFER_IN_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 },
      })
      addCase('r2-window-inside-3-days', 'savings-transfer', 'near-miss-inside',
        'exactly 3 days apart: still one internal transfer', [a, b])
    }
    if (back === 4) {
      const low = add({
        slug: 'savings-unpaired-low', day: 21, account: 'checking', amount: 200,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        confidence: 'LOW', expected: spend('TRANSFER_OUT_SAVINGS'), decisions: ['D6'],
      })
      addCase('savings-gate-outside-low', 'savings-transfer', 'near-miss-outside',
        'LOW confidence: counted as spend rather than trusted as savings', [low])

      const a = add({
        slug: 'savings-4day-out', day: 8, account: 'checking', amount: 350,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D8'],
      })
      const b = add({
        slug: 'savings-4day-in', day: 12, account: 'savings', amount: -350,
        name: 'TRANSFER FROM CHECKING', detailed: 'TRANSFER_IN_SAVINGS', cps: [],
        expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D8'],
      })
      addCase('r2-window-inside-4-days', 'savings-transfer', 'near-miss-inside',
        'the reason for the 4-day window: a Friday transfer landing Tuesday. At 3 days the inflow was counted as income', [a, b])

      const c = add({
        slug: 'savings-vs-tax-refund-out', day: 5, account: 'checking', amount: 1000,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'savings_transfer', rule: 7 }, decisions: ['D1'],
      })
      const d = add({
        slug: 'savings-vs-tax-refund-in', day: 6, account: 'nwChecking', amount: -1000,
        name: 'IRS TREAS 310 TAX REF', detailed: 'INCOME_TAX_REFUND', cps: [],
        confidence: 'VERY_HIGH', expected: income(), decisions: ['D1'],
      })
      addCase('r2-wrong-claim-tax-refund', 'savings-transfer', 'wrong-claim',
        'a $1,000 tax refund one day after a $1,000 savings transfer: D1 keeps them apart, since the inflow carries no transfer signal', [c, d])

      const e = add({
        slug: 'loan-vs-transfer-in', day: 18, account: 'savings', amount: -385.2,
        name: 'TRANSFER FROM EXTERNAL', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', cps: [],
        confidence: 'HIGH', expected: income(), decisions: ['D1'],
      })
      addCase('loan-wrong-claim-transfer-in', 'non-card-loan', 'wrong-claim',
        'an inflow that matches the car payment to the cent, same day: the car payment has no transfer signal, so D1 refuses the pair', [carPayment, e])
    }

    // ── cases: the rent coincidence ─────────────────────────────
    if (back === 1) {
      const a = add({
        slug: 'rent-cover-out', day: 1, account: 'savings', amount: 1650,
        name: 'TRANSFER TO CHECKING', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        cps: [CP.demoBank], expected: { kind: 'internal_transfer', rule: 2 },
      })
      const b = add({
        slug: 'rent-cover-in', day: 1, account: 'checking', amount: -1650,
        name: 'TRANSFER FROM SAVINGS', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.demoBank], expected: { kind: 'internal_transfer', rule: 2 },
      })
      addCase('rent-covered-by-real-transfer', 'rent-coincidence', 'easy',
        'savings tops checking up for rent: the transfer pairs and the rent is still spend, all three the same amount', [a, b, rent])
    }
    if (back === 2) {
      const a = add({
        slug: 'rent-coincidence-in', day: 1, account: 'nwChecking', amount: -1650,
        name: 'TRANSFER FROM EXTERNAL', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', cps: [],
        confidence: 'HIGH', expected: income(), decisions: ['D1'],
      })
      addCase('rent-coincidence-real-shape', 'rent-coincidence', 'wrong-claim',
        'the real user-2 row: rent out of one account, an exact-amount transfer into another, same day. D1 keeps the rent as spend', [rent, a])
    }
    if (back === 3) {
      const a = add({
        slug: 'rent-coded-transfer-out', day: 20, account: 'checking', amount: 1650,
        name: 'RENT TRANSFER', detailed: 'RENT_AND_UTILITIES_RENT', cps: [CP.northwind],
        confidence: 'LOW', expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D1'],
      })
      const b = add({
        slug: 'rent-coded-transfer-in', day: 20, account: 'nwChecking', amount: -1650,
        name: 'TRANSFER FROM DEMO BANK', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.northwind], confidence: 'HIGH',
        expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D1'],
      })
      addCase('rent-coded-but-linked-counterparty', 'rent-coincidence', 'near-miss-inside',
        'same shape, but the rent-coded leg names a linked bank: that is a transfer signal, so it pairs after all', [a, b])

      const c = add({
        slug: 'rent-linked-transfer-in', day: 1, account: 'nwChecking', amount: -1650,
        name: 'TRANSFER FROM DEMO BANK', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.demoBank], confidence: 'HIGH',
        expected: { kind: 'internal_transfer', rule: 6 }, decisions: ['D4'],
      })
      addCase('rent-day-linked-inflow', 'rent-coincidence', 'near-miss-outside',
        'an unpaired inflow with a linked-bank counterparty is an internal leg (R6), and the rent beside it is still spend', [rent, c])
    }
    if (back === 4) {
      const a = add({
        slug: 'rent-4day-out', day: 20, account: 'checking', amount: 1650,
        name: 'RENT TRANSFER', detailed: 'RENT_AND_UTILITIES_RENT', cps: [CP.northwind],
        confidence: 'LOW', expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D1', 'D8'],
      })
      const b = add({
        slug: 'rent-4day-in', day: 24, account: 'nwChecking', amount: -1650,
        name: 'TRANSFER FROM DEMO BANK', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', cps: [],
        confidence: 'HIGH', expected: { kind: 'internal_transfer', rule: 2 }, decisions: ['D1', 'D8'],
      })
      addCase('rent-coincidence-4-day-cost', 'rent-coincidence', 'wrong-claim',
        'the measured cost of D8: at 3 days this rent-coded outflow was spend; at 4 it pairs with an exact-amount inflow and disappears', [a, b])
    }

    // ── cases: the new outside boundaries, after D8 widened R2 ──
    if (back === 5) {
      const a = add({
        slug: 'savings-5day-out', day: 8, account: 'checking', amount: 340,
        name: 'TRANSFER TO SAVINGS', detailed: 'TRANSFER_OUT_SAVINGS', cps: [],
        expected: { kind: 'savings_transfer', rule: 7 }, decisions: ['D8'],
      })
      const b = add({
        slug: 'savings-5day-in', day: 13, account: 'savings', amount: -340,
        name: 'TRANSFER FROM CHECKING', detailed: 'TRANSFER_IN_SAVINGS', cps: [],
        expected: income(), decisions: ['D8'],
      })
      addCase('r2-window-outside-5-days', 'savings-transfer', 'near-miss-outside',
        '5 days is outside even the widened window: the legs stay apart and the inflow becomes income under (c)', [a, b])

      const c = add({
        slug: 'rent-5day-out', day: 20, account: 'checking', amount: 1650,
        name: 'RENT TRANSFER', detailed: 'RENT_AND_UTILITIES_RENT', cps: [CP.northwind],
        confidence: 'LOW', expected: spend('RENT_AND_UTILITIES_RENT'), decisions: ['D4', 'D8'],
      })
      const d = add({
        slug: 'rent-5day-in', day: 25, account: 'nwChecking', amount: -1650,
        name: 'TRANSFER FROM DEMO BANK', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER', cps: [],
        confidence: 'HIGH', expected: income(), decisions: ['D8'],
      })
      addCase('rent-coincidence-outside-window', 'rent-coincidence', 'near-miss-outside',
        'the same rent coincidence 5 days apart: outside the window, so the rent is still spend', [c, d])

      // D4's two directions fail differently, so they gate differently (D6).
      const e = add({
        slug: 'transfer-out-linked-medium', day: 22, account: 'checking', amount: 145,
        name: 'TRANSFER TO NORTHWIND', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        cps: [CP.northwind], confidence: 'MEDIUM',
        expected: spend('TRANSFER_OUT_ACCOUNT_TRANSFER'), decisions: ['D4', 'D6'],
      })
      addCase('transfer-out-linked-gate-medium', 'withdrawal-linked-bank', 'near-miss-outside',
        'excluding an outflow removes spend, so the outflow direction needs HIGH+: MEDIUM is counted', [e])

      const f = add({
        slug: 'transfer-in-linked-medium', day: 24, account: 'checking', amount: -220,
        name: 'TRANSFER FROM NORTHWIND', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.northwind], confidence: 'MEDIUM',
        expected: { kind: 'internal_transfer', rule: 6 }, decisions: ['D4', 'D6'],
      })
      addCase('transfer-in-linked-gate-medium', 'withdrawal-linked-bank', 'near-miss-inside',
        'excluding an inflow only removes income, which cannot flatter spend, so MEDIUM+ is enough', [f])
    }

    // ── cases: the withdrawal / linked-bank trap ────────────────
    if (back === 1) {
      const wd = add({
        slug: 'withdrawal-linked', day: 12, account: 'checking', amount: 200,
        name: 'ATM WITHDRAWAL', detailed: 'TRANSFER_OUT_WITHDRAWAL', cps: [CP.demoBank],
        confidence: 'HIGH', expected: spend('TRANSFER_OUT_WITHDRAWAL'), decisions: ['D4'],
      })
      addCase('withdrawal-linked-bank', 'withdrawal-linked-bank', 'easy',
        'the trap calibration found: cash out names your own bank, but it is spent money', [wd])

      const fee = add({
        slug: 'atm-fee', day: 12, account: 'checking', amount: 3.5,
        name: 'ATM FEE', detailed: 'BANK_FEES_ATM_FEES', cps: [CP.demoBank],
        confidence: 'HIGH', expected: spend('BANK_FEES_ATM_FEES'), decisions: ['D4'],
      })
      addCase('bank-fee-atm', 'withdrawal-linked-bank', 'wrong-claim',
        'a fee charged by your own bank is spend; only allowlisted transfer codes may be excluded', [fee])

      const inflow = add({
        slug: 'transfer-in-linked', day: 27, account: 'checking', amount: -600,
        name: 'TRANSFER FROM NORTHWIND', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.northwind], confidence: 'HIGH',
        expected: { kind: 'internal_transfer', rule: 6 }, decisions: ['D4'],
      })
      addCase('transfer-in-linked-bank', 'withdrawal-linked-bank', 'near-miss-inside',
        'the mirror of R7: an allowlisted inflow code with a linked-bank counterparty is internal', [inflow])
    }
    if (back === 2) {
      const wd = add({
        slug: 'withdrawal-no-cp', day: 9, account: 'checking', amount: 100,
        name: 'ATM WITHDRAWAL', detailed: 'TRANSFER_OUT_WITHDRAWAL', cps: [],
        confidence: 'MEDIUM', expected: spend('TRANSFER_OUT_WITHDRAWAL'),
      })
      addCase('withdrawal-no-counterparty', 'withdrawal-linked-bank', 'easy',
        'the same withdrawal without a counterparty: spend either way', [wd])

      const tr = add({
        slug: 'transfer-out-linked', day: 14, account: 'checking', amount: 750,
        name: 'TRANSFER TO NORTHWIND', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        cps: [CP.northwind], confidence: 'HIGH',
        expected: { kind: 'internal_transfer', rule: 7 }, decisions: ['D4'],
      })
      addCase('transfer-out-linked-bank', 'withdrawal-linked-bank', 'near-miss-inside',
        'an allowlisted code with a linked-bank counterparty and no second leg: excluded', [tr])

      const nsf = add({
        slug: 'bank-fee-nsf', day: 23, account: 'checking', amount: 35,
        name: 'OVERDRAFT FEE', detailed: 'BANK_FEES_INSUFFICIENT_FUNDS', cps: [CP.demoBank],
        confidence: 'LOW', expected: spend('BANK_FEES_INSUFFICIENT_FUNDS'), decisions: ['D4'],
      })
      addCase('bank-fee-overdraft', 'withdrawal-linked-bank', 'wrong-claim',
        'an overdraft fee from your own bank, at LOW confidence: still spend', [nsf])

      const student = add({
        slug: 'loan-student-same-bank', day: 22, account: 'checking', amount: 210,
        name: 'DEMO BANK STUDENT LOAN', detailed: 'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',
        cps: [CP.demoBank], confidence: 'HIGH',
        expected: spend('LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT'), decisions: ['D4'],
      })
      addCase('loan-at-your-own-bank', 'non-card-loan', 'wrong-claim',
        'a loan held at your own bank names it as counterparty: not a card payment, not a transfer, so spend', [student])
    }
    if (back === 3) {
      const wd = add({
        slug: 'withdrawal-nw-low', day: 18, account: 'nwChecking', amount: 60,
        name: 'ATM WITHDRAWAL', detailed: 'TRANSFER_OUT_WITHDRAWAL', cps: [CP.northwind],
        confidence: 'LOW', expected: spend('TRANSFER_OUT_WITHDRAWAL'), decisions: ['D4'],
      })
      addCase('withdrawal-other-institution', 'withdrawal-linked-bank', 'easy',
        'same trap at the second linked bank, LOW confidence', [wd])

      const a = add({
        slug: 'withdrawal-to-deposit-out', day: 10, account: 'checking', amount: 280,
        name: 'ATM WITHDRAWAL', detailed: 'TRANSFER_OUT_WITHDRAWAL', cps: [CP.demoBank],
        confidence: 'HIGH', expected: { kind: 'internal_transfer', rule: 2 },
      })
      const b = add({
        slug: 'withdrawal-to-deposit-in', day: 11, account: 'nwChecking', amount: -280,
        name: 'CASH DEPOSIT', detailed: 'TRANSFER_IN_DEPOSIT', cps: [CP.northwind],
        confidence: 'HIGH', expected: { kind: 'internal_transfer', rule: 2 },
      })
      addCase('withdrawal-then-deposit', 'withdrawal-linked-bank', 'near-miss-inside',
        'cash out of one bank and into another within 3 days: both legs carry a signal, so it pairs and is not spend', [a, b])

      const p2p = add({
        slug: 'bank-p2p-linked', day: 21, account: 'checking', amount: 85,
        name: 'DEMO BANK SEND MONEY', detailed: 'TRANSFER_OUT_TRANSFER_OUT_FROM_APPS',
        cps: [CP.demoBank], confidence: 'HIGH',
        expected: spend('TRANSFER_OUT_TRANSFER_OUT_FROM_APPS'), decisions: ['D4'],
      })
      addCase('bank-branded-p2p', 'withdrawal-linked-bank', 'wrong-claim',
        'a bank-branded P2P payment names the bank as counterparty, but the money left: an app code is not on the allowlist', [p2p])

      const lowIn = add({
        slug: 'transfer-in-linked-low', day: 13, account: 'checking', amount: -140,
        name: 'TRANSFER FROM DEMO BANK', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        cps: [CP.demoBank], confidence: 'LOW',
        expected: { kind: 'unclassified_inflow', rule: 6 }, decisions: ['D4', 'D6'],
      })
      addCase('transfer-in-linked-gate-outside', 'withdrawal-linked-bank', 'near-miss-outside',
        'LOW confidence on an inflow: routed to unclassified rather than income, so a doubtful transfer cannot inflate income', [lowIn])
    }
    if (back === 4) {
      const lowOut = add({
        slug: 'transfer-out-linked-low', day: 26, account: 'checking', amount: 125,
        name: 'TRANSFER TO DEMO BANK', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        cps: [CP.demoBank], confidence: 'LOW',
        expected: spend('TRANSFER_OUT_ACCOUNT_TRANSFER'), decisions: ['D4', 'D6'],
      })
      addCase('transfer-out-linked-gate-outside', 'withdrawal-linked-bank', 'near-miss-outside',
        'LOW confidence on an outflow: counted as spend rather than silently excluded', [lowOut])

      const deposit = add({
        slug: 'cash-deposit-linked', day: 14, account: 'checking', amount: -240,
        name: 'CASH DEPOSIT', detailed: 'TRANSFER_IN_DEPOSIT', cps: [CP.demoBank],
        confidence: 'HIGH', expected: income(), decisions: ['D4'],
      })
      addCase('cash-deposit-linked-bank', 'withdrawal-linked-bank', 'wrong-claim',
        'the inflow mirror of the withdrawal trap: a cash deposit at your own bank is not an internal transfer', [deposit])
    }

    // ── cases: pending (current period only) ────────────────────
    if (isCurrent) {
      const a = add({
        slug: 'pending-dining', day: lastDay, account: 'card', amount: 23.4,
        name: 'SWEETGREEN', detailed: 'FOOD_AND_DRINK_RESTAURANT', merchant: 'Sweetgreen',
        cps: [CP.merchant('Sweetgreen')], confidence: 'VERY_HIGH', pending: true,
        expected: spend('FOOD_AND_DRINK_RESTAURANT'),
      })
      const b = add({
        slug: 'pending-gas', day: lastDay, account: 'checking', amount: 41.1,
        name: 'SHELL', detailed: 'TRANSPORTATION_GAS', merchant: 'Shell',
        cps: [CP.merchant('Shell')], confidence: 'VERY_HIGH', pending: true,
        expected: spend('TRANSPORTATION_GAS'),
      })
      addCase('pending-included', 'pending', 'easy',
        'pending rows count everywhere, so today\'s spending is not invisible', [a, b])
    }
  }

  return {
    now,
    startDay: DEMO_PERIOD_START_DAY,
    items: DEMO_ITEMS,
    accounts: DEMO_ACCOUNTS,
    transactions,
    cases,
    paymentApp,
  }
}

/** The rawJson the app reads (counterparties, PFC, confidence). */
export function toRawJson(tx: DemoTransaction, plaidAccountId: string): Record<string, unknown> {
  const pfc: Record<string, string> = { primary: tx.primary, detailed: tx.detailed }
  if (tx.confidence) pfc.confidence_level = tx.confidence
  return {
    transaction_id: tx.plaidTransactionId,
    account_id: plaidAccountId,
    amount: tx.amount,
    date: tx.date,
    name: tx.name,
    merchant_name: tx.merchantName,
    pending: tx.pending,
    pending_transaction_id: null,
    personal_finance_category: pfc,
    counterparties: tx.counterparties.map((c) => ({ name: c.name, type: c.type })),
  }
}

/** Budgets are stored under DISPLAY names — what fetchBudgetsWithSpend looks up. */
export const DEMO_BUDGETS: Array<{ category: string; monthlyLimit: string }> = [
  { category: 'Food & Dining', monthlyLimit: '800.00' },
  { category: 'Transportation', monthlyLimit: '250.00' },
  { category: 'Shopping', monthlyLimit: '450.00' },
  { category: 'Entertainment', monthlyLimit: '150.00' },
  { category: 'Bills & Utilities', monthlyLimit: '2300.00' },
]
