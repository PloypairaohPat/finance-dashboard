// ─────────────────────────────────────────────────────────────────
//  period.ts — the shared money-period window (M7.2).
//
//  A user picks the day of the month their periods start on (1–28). Every
//  period-grouped view — cash flow, monthly savings, monthly spending, month
//  over month, Insights and the hero's "saved" figure — asks this file which
//  period a date belongs to, instead of each service doing its own month math.
//  Start day 1 is exactly calendar months.
//
//  Everything here is pure and UTC-only. Transaction dates are stored as UTC
//  midnight and snapshot dates as DATE, so UTC is the only arithmetic that
//  matches the data; server-local time (getMonth, setDate, toLocaleString)
//  shifts boundaries on any machine not running in UTC.
//
//  Why 28 is the maximum: every month has a 28th, so a period always starts
//  on the chosen day and no rule is needed for "the 31st in February".
//
//  An in-progress period is reported as such (inProgress, dayOfPeriod,
//  daysInPeriod) so the UI can say "so far · day 5 of 30". Nothing here
//  projects a partial period to a full one — that would hide a real
//  end-of-period squeeze.
// ─────────────────────────────────────────────────────────────────

export const MIN_PERIOD_START_DAY = 1
export const MAX_PERIOD_START_DAY = 28
export const DEFAULT_PERIOD_START_DAY = 1

const DAY_MS = 86_400_000

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export interface Period {
  /** Stable identifier: the start date, YYYY-MM-DD. */
  key: string
  /** First day of the period, YYYY-MM-DD (inclusive). */
  start: string
  /** Day after the last day, YYYY-MM-DD (exclusive) — use with `lt`. */
  end: string
  /** Last day of the period, YYYY-MM-DD (inclusive) — for display. */
  lastDay: string
  /** "Sep 2026" for start day 1, otherwise "Sep 10 – Oct 9". */
  label: string
  /** "September" for start day 1, otherwise "Sep 10 – Oct 9". */
  longLabel: string
  /** Compact axis label: "Sep '26" for start day 1, otherwise "Sep 10". */
  tickLabel: string
  startDay: number
  daysInPeriod: number
  /** True when `now` falls inside the period. */
  inProgress: boolean
  /** 1-based day `now` is on, when in progress; otherwise daysInPeriod. */
  dayOfPeriod: number
}

export function isValidPeriodStartDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PERIOD_START_DAY &&
    value <= MAX_PERIOD_START_DAY
  )
}

function assertStartDay(startDay: number): void {
  if (!isValidPeriodStartDay(startDay)) {
    throw new RangeError(`period start day must be an integer 1–28, got ${startDay}`)
  }
}

/** Date.UTC normalises month over/underflow (month -1 = previous December). */
function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day))
}

/** YYYY-MM-DD of a date's UTC calendar day. */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Parse a YYYY-MM-DD key back to 00:00 UTC. */
export function fromDateKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`)
}

/** 00:00 UTC on the first day of the period containing `date`. */
export function periodStartFor(date: Date, startDay: number): Date {
  assertStartDay(startDay)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  return date.getUTCDate() >= startDay ? utc(y, m, startDay) : utc(y, m - 1, startDay)
}

/** Start of the period `n` periods after the one starting at `start` (n may be negative). */
function shiftPeriodStart(start: Date, n: number, startDay: number): Date {
  return utc(start.getUTCFullYear(), start.getUTCMonth() + n, startDay)
}

/** [start, end) of the period containing `date`, both at 00:00 UTC. */
export function periodContaining(date: Date, startDay: number): { start: Date; end: Date } {
  const start = periodStartFor(date, startDay)
  return { start, end: shiftPeriodStart(start, 1, startDay) }
}

/** The key (start date) of the period containing `date`. */
export function periodKeyOf(date: Date, startDay: number): string {
  return toDateKey(periodStartFor(date, startDay))
}

function labelsFor(start: Date, lastDay: Date, startDay: number) {
  if (startDay === 1) {
    const m = start.getUTCMonth()
    const y = start.getUTCFullYear()
    return {
      label: `${MONTHS_SHORT[m]} ${y}`,
      longLabel: MONTHS_LONG[m],
      tickLabel: `${MONTHS_SHORT[m]} '${String(y).slice(2)}`,
    }
  }
  const from = `${MONTHS_SHORT[start.getUTCMonth()]} ${start.getUTCDate()}`
  const to = `${MONTHS_SHORT[lastDay.getUTCMonth()]} ${lastDay.getUTCDate()}`
  return { label: `${from} – ${to}`, longLabel: `${from} – ${to}`, tickLabel: from }
}

/** Describe the period starting at `start`, relative to `now`. */
export function describePeriod(start: Date, startDay: number, now: Date): Period {
  assertStartDay(startDay)
  const end = shiftPeriodStart(start, 1, startDay)
  const lastDay = new Date(end.getTime() - DAY_MS)
  const daysInPeriod = Math.round((end.getTime() - start.getTime()) / DAY_MS)
  const inProgress = now.getTime() >= start.getTime() && now.getTime() < end.getTime()
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dayOfPeriod = inProgress
    ? Math.floor((today.getTime() - start.getTime()) / DAY_MS) + 1
    : daysInPeriod
  return {
    key: toDateKey(start),
    start: toDateKey(start),
    end: toDateKey(end),
    lastDay: toDateKey(lastDay),
    ...labelsFor(start, lastDay, startDay),
    startDay,
    daysInPeriod,
    inProgress,
    dayOfPeriod,
  }
}

/**
 * The `count` most recent periods, oldest first. The last one contains `now`
 * (and is therefore in progress). Contiguous: each period's `end` is the next
 * one's `start`.
 */
export function recentPeriods(now: Date, startDay: number, count: number): Period[] {
  assertStartDay(startDay)
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`period count must be a positive integer, got ${count}`)
  }
  const current = periodStartFor(now, startDay)
  const out: Period[] = []
  for (let i = count - 1; i >= 0; i--) {
    out.push(describePeriod(shiftPeriodStart(current, -i, startDay), startDay, now))
  }
  return out
}

/**
 * Given ascending YYYY-MM-DD dates (e.g. daily net-worth snapshots), return the
 * dates that are the first data point of a new period — where to draw a period
 * marker on a day-based chart. The first date is never a marker.
 */
export function periodBoundaryDates(sortedDateKeys: string[], startDay: number): string[] {
  assertStartDay(startDay)
  const out: string[] = []
  for (let i = 1; i < sortedDateKeys.length; i++) {
    const prev = periodKeyOf(fromDateKey(sortedDateKeys[i - 1]), startDay)
    const curr = periodKeyOf(fromDateKey(sortedDateKeys[i]), startDay)
    if (prev !== curr) out.push(sortedDateKeys[i])
  }
  return out
}

/**
 * Drop the periods that end before a user's first transaction — periods they
 * had no history in yet. A zero there isn't a gap, it's a period they didn't
 * exist in, and it would drag averages toward zero.
 *
 * The period containing `firstActivity`, and every period after it, is kept,
 * including empty ones between transactions: an interior zero is real and must
 * stay visible. With no activity at all, returns no periods.
 */
export function periodsFromFirstActivity<T extends Pick<Period, "end">>(
  periods: readonly T[],
  firstActivity: Date | null,
): T[] {
  if (!firstActivity) return []
  return periods.filter((p) => fromDateKey(p.end).getTime() > firstActivity.getTime())
}
