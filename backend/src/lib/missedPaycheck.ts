// ─────────────────────────────────────────────────────────────────
//  missedPaycheck — the missed-paycheck alert's rules (M7.6 PR 6b), pure.
//  The plan and every decision: docs/m7.6-missed-paycheck.md.
//
//  Only for a user who opted in, and only for a stored inflow stream with a
//  salary code, MATURE, active, on a fixed frequency (lib/paydays: exclusionOf).
//  It never fires on irregular income: that has no such stream.
//
//    payday     Plaid's predicted date when it's after the stream's last
//               deposit; otherwise the next payday on the stream's own
//               schedule. When the payday after it has come, that one is
//               judged instead: an alert resolves at the next payday.
//    deadline   GRACE_BANKING_DAYS banking days after the payday (weekends
//               and Federal Reserve holidays skipped; lib/businessDays).
//    arrived    a deposit into the stream's account, from half a period
//               before the payday to today (late pay counts, so the alert
//               resolves when it lands), that the classifier calls
//               income, that is in the stream or carries a salary code (and
//               isn't another paycheck stream's deposit: with two employers
//               paying one account, one's pay can't hide the other's), and is
//               at least ARRIVAL_FLOOR of the usual amount — with no upper
//               limit, so a bonus or overtime never reads as missing. A
//               pending deposit counts.
//    fires      the day after the deadline, if nothing arrived and the data
//               is current past the deadline: the Item synced and refreshed
//               its streams after it, and is healthy. When the data isn't,
//               nothing new fires, and an alert already raised stays.
//
//  One alert per account and payday: missed_paycheck:{plaidAccountId}:{date}.
//  A state alert: it resolves by absence when pay arrives, when the setting is
//  turned off, when the stream stops qualifying, or at the next payday.
// ─────────────────────────────────────────────────────────────────

import type { Alert } from '@prisma/client'
import type { DetectedAlert } from '../services/alerts/types'
import { addBusinessDays, dayOf } from './businessDays'
import { HALF_PERIOD_DAYS, SALARY_CODES, nominalSchedule, type PayFrequency } from './paydays'

const DAY = 86_400_000

/** Banking days after a payday before it counts as missed. */
export const GRACE_BANKING_DAYS = 2
/** A deposit counts as the paycheck at this share of the usual amount or more. No upper limit. */
export const ARRIVAL_FLOOR = 0.5
/** How many recent deposits the usual amount is the median of. */
const USUAL_OF = 6

export interface PaycheckStream {
  plaidItemId: string
  /** Plaid's account id: the fingerprint's key, stable when Plaid regroups a stream. */
  plaidAccountId: string
  /** Our account row, or null if we don't have it. */
  accountId: string | null
  accountName: string
  payer: string
  frequency: PayFrequency
  predictedNextDate: Date | null
  /** The stream's own deposits in our rows. Amounts in Transaction.amount's sign: negative is money in. */
  deposits: Array<{ id: string; date: Date; amount: number }>
}

export interface PaycheckItem {
  lastSyncedAt: Date | null
  streamsRefreshedAt: Date | null
  status: string
}

export interface PaycheckInput {
  /** User.missedPaycheckAlerts. Off: nothing fires, and anything raised resolves. */
  enabled: boolean
  /** Qualifying streams only. */
  streams: PaycheckStream[]
  items: Map<string, PaycheckItem>
}

/** A classified row, as far as arrival reads it. */
export interface PaycheckRow {
  id: string
  accountId: string
  date: Date
  amount: number
  categoryDetailed: string | null
  verdict: { kind: string }
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Fri 2 Oct", in UTC like every date in the app. */
const spoken = (t: number) => {
  const d = new Date(t)
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** The payday after `p` on the stream's schedule. */
function paydayAfter(deposits: number[], f: PayFrequency, p: number): number | null {
  if (f === 'WEEKLY') return p + 7 * DAY
  if (f === 'BIWEEKLY') return p + 14 * DAY
  // Monthly and semi-monthly: the next nominal date clear of this one (Plaid's
  // date can sit a day or two off our grid).
  return nominalSchedule(deposits, f, p + 70 * DAY).find((d) => d > p + 3 * DAY) ?? null
}

/** The payday being judged today, or null if the stream gives none. */
export function currentPayday(s: PaycheckStream, today: number): number | null {
  const deposits = s.deposits.map((d) => dayOf(d.date)).sort((a, b) => a - b)
  const last = deposits[deposits.length - 1]
  let p: number | null = null
  if (s.predictedNextDate && (last === undefined || dayOf(s.predictedNextDate) > last)) p = dayOf(s.predictedNextDate)
  else if (last !== undefined) p = paydayAfter(deposits, s.frequency, last)
  if (p === null) return null
  // Rolled on to the latest payday that has come: an earlier one's alert resolves at it.
  for (let next = paydayAfter(deposits, s.frequency, p); next !== null && next <= today; next = paydayAfter(deposits, s.frequency, p)) p = next
  return p
}

export function judgePaychecks(args: {
  input: PaycheckInput
  rows: readonly PaycheckRow[]
  activeAlerts: Map<string, Alert>
  now: Date
}): DetectedAlert[] {
  const { input, rows, activeAlerts } = args
  if (!input.enabled) return []
  const today = dayOf(args.now)
  const out = new Map<string, DetectedAlert>()
  // Which stream each known deposit belongs to.
  const streamOf = new Map<string, PaycheckStream>()
  for (const s of input.streams) for (const d of s.deposits) streamOf.set(d.id, s)

  for (const s of input.streams) {
    const payday = currentPayday(s, today)
    if (payday === null) continue
    const deadline = addBusinessDays(payday, GRACE_BANKING_DAYS)
    if (today <= deadline) continue

    const own = new Set(s.deposits.map((d) => d.id))
    const recent = [...s.deposits].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, USUAL_OF)
    const usual = median(recent.map((d) => Math.abs(d.amount)))
    const from = payday - HALF_PERIOD_DAYS[s.frequency] * DAY
    const arrived = rows.some((r) => {
      const d = dayOf(r.date)
      return r.accountId === s.accountId
        && r.amount < 0
        && r.verdict.kind === 'income'
        && (own.has(r.id) || (
          !streamOf.has(r.id)
          && r.categoryDetailed !== null && (SALARY_CODES as readonly string[]).includes(r.categoryDetailed)))
        && d >= from && d <= today
        && Math.abs(r.amount) >= ARRIVAL_FLOOR * usual
    })
    if (arrived) continue

    const fingerprint = `missed_paycheck:${s.plaidAccountId}:${iso(payday)}`
    const item = input.items.get(s.plaidItemId)
    const current = (t: Date | null | undefined) => !!t && t.getTime() >= deadline + DAY
    const fresh = !!item && item.status === 'healthy' && current(item.lastSyncedAt) && current(item.streamsRefreshedAt)
    // Behind: say nothing new, but don't let an alert already raised resolve.
    if (!fresh && !activeAlerts.has(fingerprint)) continue

    out.set(fingerprint, {
      kind: 'missed_paycheck',
      fingerprint,
      severity: 'medium',
      title: `Your paycheck from ${s.payer} hasn't arrived`,
      body: `It's usually paid around ${spoken(payday)} and hasn't reached ${s.accountName} ${GRACE_BANKING_DAYS} banking days later. ` +
        `Deposits are sometimes late, and a holiday or a change at work can move a payday. This clears when it arrives.`,
      data: { payer: s.payer, expectedDate: iso(payday), deadline: iso(deadline) },
    })
  }
  return [...out.values()]
}
