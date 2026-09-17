// ─────────────────────────────────────────────────────────────────
//  classification.service.ts — load a user's rows and classify them (M7.3).
//
//  The one place that turns database rows into classifier input, so the six
//  endpoints being converted don't each grow their own copy of the Prisma
//  select, the rawJson unpacking and the window padding.
//
//  Window padding matters and is easy to get wrong: R1 pairs a card payment
//  with an inflow up to 7 days away and R2 pairs transfers up to 4 days away,
//  either side. Classifying exactly the rows a period contains would break
//  every pair that straddles a period boundary — the payment would be counted
//  as spend and its partner as income, which is the very bug being fixed. So
//  rows are loaded with a pad on both ends, classified together, and the
//  caller filters by date afterwards.
// ─────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks'
import prisma from '../lib/prisma'
import {
  MAX_RULE_LOOKBACK_DAYS,
  classify,
  type ClassificationResult,
  type ClassifierTx,
  type Classified,
  isCappedPaymentApp,
  isPaymentAppOutflow,
} from '../lib/classifier'
import { periodContaining, periodKeyOf } from '../lib/period'

/**
 * Taken from the rules themselves, so widening a pairing window widens the
 * padding with it. Hardcoding this is how pairing breaks at period boundaries
 * months after someone changes an unrelated constant.
 */
export const PAIRING_PAD_DAYS = MAX_RULE_LOOKBACK_DAYS
const DAY_MS = 86_400_000

/** The user settings the classifier itself reads. */
export interface ClassifierSettings {
  paymentAppInflowsAreIncome: boolean
}

// Answering "what would this user's figures be with the setting the other way?"
// without touching their stored setting. Every figure in the app is computed
// through classifyWindow, most of it several services deep, so the alternative
// is threading an option through every signature. Scoped to one async call:
// nothing outside withClassifierSettings sees it.
const settingsOverride = new AsyncLocalStorage<ClassifierSettings>()

export function withClassifierSettings<T>(settings: ClassifierSettings, fn: () => Promise<T>): Promise<T> {
  return settingsOverride.run(settings, fn)
}

export async function getClassifierSettings(userId: string): Promise<ClassifierSettings> {
  const override = settingsOverride.getStore()
  if (override) return override
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { paymentAppInflowsAreIncome: true },
  })
  return { paymentAppInflowsAreIncome: row?.paymentAppInflowsAreIncome ?? false }
}

export interface ClassifiedRow {
  id: string
  accountId: string
  date: Date
  amount: number
  pending: boolean
  categoryPrimary: string | null
  categoryDetailed: string | null
  merchantLabel: string
  verdict: Classified
}

export interface ClassifiedWindow {
  /** Rows inside the requested window, verdicts attached. */
  rows: ClassifiedRow[]
  /** The full classification, including padding rows and the per-period cap. */
  result: ClassificationResult
  /** Payment-app spend after the cap, by period key. */
  paymentAppByPeriod: Map<string, number>
  /** The settings these verdicts were produced under. */
  settings: ClassifierSettings
}

export async function classifyWindow(
  userId: string,
  window: { since: Date; until: Date; startDay: number },
): Promise<ClassifiedWindow> {
  const paddedSince = new Date(window.since.getTime() - PAIRING_PAD_DAYS * DAY_MS)
  const paddedUntil = new Date(window.until.getTime() + PAIRING_PAD_DAYS * DAY_MS)

  const [settings, accounts, items, rows] = await Promise.all([
    getClassifierSettings(userId),
    prisma.account.findMany({ where: { userId }, select: { id: true, type: true, plaidItem: { select: { institutionName: true } } } }),
    prisma.plaidItem.findMany({ where: { userId }, select: { institutionName: true } }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null, date: { gte: paddedSince, lt: paddedUntil } },
      select: {
        id: true, accountId: true, date: true, amount: true, pending: true,
        categoryPrimary: true, categoryDetailed: true, cleanName: true, name: true, rawJson: true,
      },
      orderBy: { date: 'asc' },
    }),
  ])

  const accountType = new Map(accounts.map((a) => [a.id, a.type]))
  const institutionsWithCreditAccount = accounts
    .filter((a) => a.type === 'credit')
    .map((a) => a.plaidItem?.institutionName)
    .filter(Boolean) as string[]

  const prepared = rows.map((r) => {
    const raw = (r.rawJson ?? {}) as Record<string, unknown>
    const pfc = (raw.personal_finance_category ?? {}) as Record<string, string>
    return {
      row: r,
      input: {
        id: r.id,
        accountId: r.accountId,
        accountType: accountType.get(r.accountId) ?? 'depository',
        date: r.date,
        amount: r.amount.toNumber(),
        categoryPrimary: r.categoryPrimary,
        categoryDetailed: r.categoryDetailed,
        confidence: pfc.confidence_level ?? null,
        counterparties: (Array.isArray(raw.counterparties) ? raw.counterparties : []) as Array<{
          name?: string | null
          type?: string | null
        }>,
        pending: r.pending,
      } satisfies ClassifierTx,
    }
  })

  const result = classify(
    prepared.map((p) => p.input),
    {
      linkedInstitutions: items.map((i) => i.institutionName).filter(Boolean) as string[],
      institutionsWithCreditAccount,
      periodKeyOf: (d: Date) => periodKeyOf(d, window.startDay),
      paymentAppInflowsAreIncome: settings.paymentAppInflowsAreIncome,
    },
  )

  const inWindow = prepared.filter((p) => p.row.date >= window.since && p.row.date < window.until)

  // R4's cap is a whole-period figure, so it is only meaningful for periods the
  // query covered end to end. The padding rows pull in a few days of the
  // neighbouring periods; reporting a cap for those would hand the caller a
  // partial total that looks complete. Drop them instead.
  const fullyCovered = (periodKey: string) => {
    const { start, end } = periodContaining(new Date(`${periodKey}T00:00:00.000Z`), window.startDay)
    return start >= window.since && end <= window.until
  }

  return {
    rows: inWindow.map((p) => ({
      id: p.row.id,
      accountId: p.row.accountId,
      date: p.row.date,
      amount: p.input.amount,
      pending: p.row.pending,
      categoryPrimary: p.row.categoryPrimary,
      categoryDetailed: p.row.categoryDetailed,
      merchantLabel: p.row.cleanName ?? p.row.name ?? 'Unknown',
      verdict: result.byId.get(p.row.id)!,
    })),
    result,
    settings,
    paymentAppByPeriod: new Map(
      result.paymentApp.filter((p) => fullyCovered(p.key)).map((p) => [p.key, p.spend]),
    ),
  }
}

// ── the figures every converted endpoint needs ────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Spend for one period: ordinary spend, refunds netted off, and payment-app
 * payments at their capped total rather than row by row (D5).
 */
export function spendForPeriod(
  rows: readonly ClassifiedRow[],
  periodKey: string,
  startDay: number,
  paymentAppByPeriod: Map<string, number>,
): number {
  let total = 0
  for (const r of rows) {
    if (periodKeyOf(r.date, startDay) !== periodKey) continue
    if (isCappedPaymentApp(r.verdict)) continue // capped below
    if (r.verdict.kind === 'spend' || r.verdict.kind === 'refund') total += r.amount
  }
  return round2(total + (paymentAppByPeriod.get(periodKey) ?? 0))
}

/** Income for one period: definition (c), after every exclusion. */
export function incomeForPeriod(
  rows: readonly ClassifiedRow[],
  periodKey: string,
  startDay: number,
): number {
  let total = 0
  for (const r of rows) {
    if (periodKeyOf(r.date, startDay) !== periodKey) continue
    if (r.verdict.kind === 'income') total += -r.amount
  }
  return round2(total)
}

/** Everything except payment apps, whose total is capped rather than summed. */
function bucketsExcludingPaymentApps(rows: readonly ClassifiedRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (isCappedPaymentApp(r.verdict)) continue
    if (r.verdict.kind === 'spend') {
      const bucket = r.verdict.bucket ?? 'Other'
      out[bucket] = round2((out[bucket] ?? 0) + r.amount)
    } else if (r.verdict.kind === 'refund') {
      const bucket = r.verdict.netsAgainst ?? 'Unallocated refunds'
      out[bucket] = round2((out[bucket] ?? 0) + r.amount)
    }
  }
  return out
}

/** Spend by display bucket for one period, refunds netted against their category. */
export function spendByBucket(
  rows: readonly ClassifiedRow[],
  periodKey: string,
  startDay: number,
  paymentAppByPeriod: Map<string, number>,
  paymentsToPeopleLabel: string,
): Record<string, number> {
  const out = bucketsExcludingPaymentApps(
    rows.filter((r) => periodKeyOf(r.date, startDay) === periodKey),
  )
  const ptp = paymentAppByPeriod.get(periodKey) ?? 0
  if (ptp > 0) out[paymentsToPeopleLabel] = round2((out[paymentsToPeopleLabel] ?? 0) + ptp)
  return out
}

/**
 * The payment-app cap (D5) over exactly the rows given.
 *
 * PERIOD-SCOPED: only correct when the rows are one whole money period. The
 * floor at zero is what makes it so — applied to a week or any other slice it
 * does not give a smaller version of the right answer, it gives a confidently
 * wrong one. For any other window use paymentAppFlowsForRows and report the two
 * gross sums instead.
 */
export function paymentAppCapForRows(rows: readonly ClassifiedRow[]): number {
  let out = 0
  let inflow = 0
  for (const r of rows) {
    if (!isCappedPaymentApp(r.verdict)) continue
    if (isPaymentAppOutflow(r.verdict)) out += r.amount
    else inflow += -r.amount
  }
  return round2(Math.max(0, out - Math.min(out, inflow)))
}

/** Spend by bucket over one whole period's rows, cap included. PERIOD-SCOPED, as above. */
export function spendByBucketForRows(
  rows: readonly ClassifiedRow[],
  paymentsToPeopleLabel: string,
): Record<string, number> {
  const out = bucketsExcludingPaymentApps(rows)
  const ptp = paymentAppCapForRows(rows)
  if (ptp > 0) out[paymentsToPeopleLabel] = round2((out[paymentsToPeopleLabel] ?? 0) + ptp)
  return out
}

// ── row-scoped: safe over any date range ──────────────────────────
//
// Plain sums over rows. No floor, no cap, nothing that assumes the rows are a
// whole period — so these are the ones to use for a week, a custom range, or
// anything else that is not exactly one money period.

/** Ordinary spending by bucket, refunds netted, payments to people left out. */
export function ordinarySpendByBucketForRows(rows: readonly ClassifiedRow[]): Record<string, number> {
  return bucketsExcludingPaymentApps(rows)
}

/** Payments to people as two gross sums — the "$X out, $Y in" line, never netted. */
export function paymentAppFlowsForRows(rows: readonly ClassifiedRow[]): { out: number; in: number } {
  let out = 0
  let inflow = 0
  for (const r of rows) {
    if (!isCappedPaymentApp(r.verdict)) continue
    if (isPaymentAppOutflow(r.verdict)) out += r.amount
    else inflow += -r.amount
  }
  return { out: round2(out), in: round2(inflow) }
}

// ── the savings-rate floor ────────────────────────────────────────

/** When the median can't be computed, the floor money income must clear. */
export const SAVINGS_RATE_FALLBACK_FLOOR = 100
const FLOOR_FRACTION = 0.25
const FLOOR_LOOKBACK_PERIODS = 3

export interface SavingsRate {
  /** Percent, unclamped — or null when income is under the floor. */
  rate: number | null
  floor: number
  /** True when a rate exists arithmetically but is too unreliable to show. */
  suppressed: boolean
}

/**
 * Savings rate, with the floor that stops a period with almost no income
 * producing a headline like -8431.6%.
 *
 * The floor is 25% of the median income of the last three COMPLETED periods
 * that had any income. The rate itself is never clamped: a real -40% period
 * must still read -40%.
 *
 * The $100 is a BOOTSTRAP for users with no income history yet — it is not a
 * minimum applied on top of the relative rule, and the floor is deliberately
 * NOT max(25% of median, $100). Someone earning a $300 median who has a period
 * at 27% of normal is having an ordinary month by their own standard and must
 * see their number; a $100 minimum would hide it. The relative rule is the
 * rule, and the constant only stands in when there is nothing to be relative to.
 */
export function savingsRateFor(
  income: number,
  netSaved: number,
  completedPeriodIncomes: readonly number[],
): SavingsRate {
  const withIncome = completedPeriodIncomes.filter((v) => v > 0).slice(-FLOOR_LOOKBACK_PERIODS)
  let floor = SAVINGS_RATE_FALLBACK_FLOOR
  if (withIncome.length > 0) {
    const sorted = [...withIncome].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    floor = round2(median * FLOOR_FRACTION)
  }
  if (income < floor) return { rate: null, floor, suppressed: income > 0 }
  return { rate: Number(((netSaved / income) * 100).toFixed(1)), floor, suppressed: false }
}
