// ─────────────────────────────────────────────────────────────────
//  paycheckBacktest — the pure part of scripts/missed-paycheck-backtest.ts.
//
//  Which inflow streams qualify for a missed-paycheck alert, the paydays a
//  stream's deposits imply, and how each payday went: on time, late by some
//  banking days, or never. No database, no clock: the script supplies both.
//  Dates are UTC midnights in ms.
//
//  The schedule is NOMINAL, inferred from all the stream's deposits: the usual
//  day of the month (one in each half for SEMI_MONTHLY), or the usual phase of
//  the week or fortnight. Anchoring each payday on the previous deposit drifts
//  instead: pay sent early because the 15th is a Sunday would make next month's
//  15th look two days late. Inferring from all deposits uses hindsight a live
//  alert wouldn't have — it stands in for Plaid's predicted_next_date, which is
//  only ever the next one, so history can't be judged against it.
// ─────────────────────────────────────────────────────────────────

import { addBusinessDays, businessDaysAfter, dayOf } from './businessDays'

const DAY = 86_400_000

/** Plaid's salary codes: INCOME_SALARY (PFCv2), INCOME_WAGES where a v1 Item still sends it. Never the INCOME primary. */
export const SALARY_CODES = ['INCOME_SALARY', 'INCOME_WAGES'] as const
/** Fixed schedules a payday can be predicted on. ANNUALLY and UNKNOWN never qualify. */
export const PAY_FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as const
export type PayFrequency = (typeof PAY_FREQUENCIES)[number]

export type Exclusion = 'outflow' | 'not a salary code' | 'not mature' | 'inactive' | 'no fixed frequency'

/** Why a stream doesn't qualify, or null if it does. Checked in this order. */
export function exclusionOf(s: { direction: string; pfcDetailed: string | null; status: string; isActive: boolean; frequency: string }): Exclusion | null {
  if (s.direction !== 'inflow') return 'outflow'
  if (!s.pfcDetailed || !(SALARY_CODES as readonly string[]).includes(s.pfcDetailed)) return 'not a salary code'
  if (s.status !== 'MATURE') return 'not mature'
  if (!s.isActive) return 'inactive'
  if (!(PAY_FREQUENCIES as readonly string[]).includes(s.frequency)) return 'no fixed frequency'
  return null
}

/** Half a pay period: a deposit this far either side of a payday belongs to it. */
export const HALF_PERIOD_DAYS: Record<PayFrequency, number> = { WEEKLY: 3, BIWEEKLY: 7, SEMI_MONTHLY: 7, MONTHLY: 14 }

/**
 * The most common value. Ties go to the smallest, or with `latest` to the
 * largest: a payday moved for a weekend or holiday is always paid EARLIER, so
 * between the usual day and an early one seen as often, the usual day is the later.
 */
function mode(xs: readonly number[], latest = false): number {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (latest ? b[0] - a[0] : a[0] - b[0]))[0][0]
}

/**
 * A deposit's day of the month, with any of the month's last three days read as
 * "the last day" (31, clamped per month): a month-end payday moved back for a
 * weekend lands on the 27th of a 30-day month or the 26th of February.
 */
const monthDay = (t: number) => {
  const d = new Date(t)
  const length = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  return length - d.getUTCDate() <= 3 ? 31 : d.getUTCDate()
}

const dateIn = (y: number, m: number, dom: number) =>
  Date.UTC(y, m, Math.min(dom, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))

/** Nominal paydays from just after the first deposit to `until`. */
export function nominalSchedule(deposits: readonly number[], f: PayFrequency, until: number): number[] {
  const days = [...deposits].map(dayOf).sort((a, b) => a - b)
  if (days.length === 0) return []
  const from = days[0] + HALF_PERIOD_DAYS[f] * DAY
  const out: number[] = []
  if (f === 'WEEKLY' || f === 'BIWEEKLY') {
    const p = f === 'WEEKLY' ? 7 : 14
    const phase = mode(days.map((d) => ((d / DAY) % p + p) % p))
    let t = Math.ceil(from / DAY)
    while (((t % p) + p) % p !== phase) t++
    for (let d = t * DAY; d <= until; d += p * DAY) out.push(d)
    return out
  }
  const doms = f === 'MONTHLY'
    ? [mode(days.map(monthDay), true)]
    : [mode(days.map(monthDay).filter((x) => x <= 15), true), mode(days.map(monthDay).filter((x) => x > 15), true)]
  const start = new Date(days[0])
  for (let k = 0; ; k++) {
    const y = start.getUTCFullYear(), m = start.getUTCMonth() + k
    const month = doms.map((dom) => dateIn(y, m, dom)).sort((a, b) => a - b)
    if (month[0] > until) break
    for (const d of month) if (d >= from && d <= until) out.push(d)
  }
  return out
}

export interface Payday {
  expected: number
  /** The deposit matched to it, or null if none came within half a period. */
  arrived: number | null
  /** Banking days after the expected date it arrived (0: on time or early). null: never. */
  lateBy: number | null
}

/**
 * Each nominal payday after the first deposit, up to `until`, with the
 * deposit nearest to it within half a period, each deposit used once. A
 * SEMI_MONTHLY stream needs a deposit in each half of the month to have a
 * schedule; with fewer, there's nothing to judge.
 */
export function paydays(deposits: readonly number[], f: PayFrequency, until: number): Payday[] {
  const days = [...deposits].map(dayOf).sort((a, b) => a - b)
  if (f === 'SEMI_MONTHLY') {
    const doms = days.map((d) => new Date(d).getUTCDate())
    if (!doms.some((x) => x <= 15) || !doms.some((x) => x > 15)) return []
  }
  const used = new Set<number>([0])
  const half = HALF_PERIOD_DAYS[f] * DAY
  return nominalSchedule(days, f, until).map((expected) => {
    let best = -1
    for (let i = 0; i < days.length; i++) {
      if (used.has(i) || Math.abs(days[i] - expected) > half) continue
      if (best < 0 || Math.abs(days[i] - expected) < Math.abs(days[best] - expected)) best = i
    }
    if (best < 0) return { expected, arrived: null, lateBy: null }
    used.add(best)
    return { expected, arrived: days[best], lateBy: businessDaysAfter(expected, days[best]) }
  })
}

/** The last banking day pay can arrive before the alert would fire: `grace` banking days after the payday. */
export const deadline = (expected: number, grace: number) => addBusinessDays(expected, grace)

/** Whether the alert would fire for this payday at this grace. */
export const wouldFire = (p: Payday, grace: number) => p.lateBy === null || p.lateBy > grace
