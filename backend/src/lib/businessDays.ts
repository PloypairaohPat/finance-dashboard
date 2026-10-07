// ─────────────────────────────────────────────────────────────────
//  businessDays — US banking days: not a weekend, not a Federal Reserve
//  holiday. ACH deposits settle on banking days only, so "late" for a
//  paycheck is counted in these. UTC dates throughout (YYYY-MM-DD at midnight),
//  like every date in the app.
//
//  The Federal Reserve's holidays (federalreserve.gov, "Holidays Observed by
//  the Federal Reserve System"): a holiday on a Sunday is observed the Monday
//  after; one on a Saturday is not moved (the Reserve Banks open the Friday
//  before), so that Friday is still a banking day.
//
//  Used by the missed-paycheck alert (lib/missedPaycheck.ts) and its backtest
//  (scripts/missed-paycheck-backtest.ts).
// ─────────────────────────────────────────────────────────────────

const DAY = 86_400_000

const ymd = (y: number, m: number, d: number) => Date.UTC(y, m, d)
/** The n-th (1-based) weekday `dow` (0 = Sunday) of a month; n = -1 for the last. */
function nthWeekday(y: number, m: number, dow: number, n: number): number {
  if (n > 0) {
    const first = new Date(ymd(y, m, 1)).getUTCDay()
    return ymd(y, m, 1 + ((dow - first + 7) % 7) + 7 * (n - 1))
  }
  const lastDay = new Date(ymd(y, m + 1, 0))
  return ymd(y, m, lastDay.getUTCDate() - ((lastDay.getUTCDay() - dow + 7) % 7))
}
/** A fixed-date holiday as the Reserve observes it: Sunday moves to Monday; Saturday doesn't move. */
const observed = (t: number) => (new Date(t).getUTCDay() === 0 ? t + DAY : t)

const cache = new Map<number, Set<number>>()
export function federalReserveHolidays(year: number): Set<number> {
  const hit = cache.get(year)
  if (hit) return hit
  const days = new Set<number>([
    observed(ymd(year, 0, 1)),         // New Year's Day
    nthWeekday(year, 0, 1, 3),         // Birthday of Martin Luther King, Jr.
    nthWeekday(year, 1, 1, 3),         // Washington's Birthday
    nthWeekday(year, 4, 1, -1),        // Memorial Day
    observed(ymd(year, 5, 19)),        // Juneteenth
    observed(ymd(year, 6, 4)),         // Independence Day
    nthWeekday(year, 8, 1, 1),         // Labor Day
    nthWeekday(year, 9, 1, 2),         // Columbus Day
    observed(ymd(year, 10, 11)),       // Veterans Day
    nthWeekday(year, 10, 4, 4),        // Thanksgiving Day
    observed(ymd(year, 11, 25)),       // Christmas Day
  ])
  cache.set(year, days)
  return days
}

/** UTC midnight of the day containing `t`. */
export const dayOf = (t: number | Date) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function isBusinessDay(t: number | Date): boolean {
  const day = dayOf(t)
  const dow = new Date(day).getUTCDay()
  if (dow === 0 || dow === 6) return false
  return !federalReserveHolidays(new Date(day).getUTCFullYear()).has(day)
}

/** The day itself if it's a banking day, else the next one. */
export function onOrAfterBusinessDay(t: number | Date): number {
  let day = dayOf(t)
  while (!isBusinessDay(day)) day += DAY
  return day
}

/** `n` banking days after the banking day on or after `t`. */
export function addBusinessDays(t: number | Date, n: number): number {
  let day = onOrAfterBusinessDay(t)
  for (let i = 0; i < n; i++) {
    day += DAY
    while (!isBusinessDay(day)) day += DAY
  }
  return day
}

/** Banking days from the banking day on or after `from` to `to` (0 if `to` is on or before it). */
export function businessDaysAfter(from: number | Date, to: number | Date): number {
  const start = onOrAfterBusinessDay(from)
  const end = dayOf(to)
  let n = 0
  for (let day = start + DAY; day <= end; day += DAY) if (isBusinessDay(day)) n++
  return n
}
