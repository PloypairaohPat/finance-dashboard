import type { Account, Budget, Transaction } from "@prisma/client"
import type { SubscriptionAnalysis } from "../subscriptions.service"

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
// Loading once avoids N DB round-trips when we run 7 detectors.
export interface DetectorContext {
  userId: string
  now: Date
  accounts: Account[]
  transactions: Transaction[]       // last 120 days
  budgets: Budget[]                 // current month
  subscriptionAnalysis: SubscriptionAnalysis | null  // null if we couldn't fetch
}

export type Detector = (ctx: DetectorContext) => DetectedAlert[] | Promise<DetectedAlert[]>