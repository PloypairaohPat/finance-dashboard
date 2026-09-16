import type { Account, Alert, Budget } from "@prisma/client"
import type { SubscriptionAnalysis } from "../subscriptions.service"
import type { ClassifiedRow } from "../classification.service"
import type { Period } from "../../lib/period"

export type AlertKind =
  | "overspending"
  | "low_balance"
  | "missed_paycheck"
  | "large_transaction"
  | "subscription_price_up"
  | "budget_exceeded"
  | "budget_projected_over"
  | "positive_milestone"

export type Severity = "high" | "medium" | "low" | "positive"

export interface DetectedAlert {
  kind: AlertKind
  fingerprint: string      // stable; upsert key
  severity: Severity
  title: string
  body: string
  data?: Record<string, unknown>
}

// Shared context — loaded once, passed to every detector.
//
// M7.3: detectors are given CLASSIFIED rows, not raw transactions. Raw rows are
// deliberately not here: while they were, each detector re-decided what counted
// as spending, and five of them decided differently from the screens their
// alerts refer to. A detector that needs to know what a transaction means now
// has to read the verdict.
export interface DetectorContext {
  userId: string
  now: Date
  /** The user's money-period start day (1–28). */
  startDay: number
  accounts: Account[]
  /** The money periods covered, oldest first; the last one is in progress. */
  periods: Period[]
  /** Every row in those periods, with its classifier verdict. */
  classified: ClassifiedRow[]
  /** Payment-app spend after the per-period cap, by period key. */
  paymentAppByPeriod: Map<string, number>
  budgets: Budget[]
  subscriptionAnalysis: SubscriptionAnalysis | null  // null if we couldn't fetch
  /**
   * Alerts still standing, by fingerprint — not resolved, not deleted, whether
   * or not the user dismissed them. A detector needs this when "still true"
   * depends on whether it is already firing (hysteresis).
   */
  activeAlerts: Map<string, Alert>
}

/** The period every "this month" figure in a detector refers to. */
export function currentPeriod(ctx: DetectorContext): Period {
  return ctx.periods[ctx.periods.length - 1]
}

/** The completed periods before the current one, most recent last. */
export function priorPeriods(ctx: DetectorContext, count: number): Period[] {
  return ctx.periods.slice(Math.max(0, ctx.periods.length - 1 - count), ctx.periods.length - 1)
}

export type Detector = (ctx: DetectorContext) => DetectedAlert[] | Promise<DetectedAlert[]>