export interface Account {
  id: string
  plaidAccountId: string
  name: string
  officialName: string | null
  type: string
  subtype: string | null
  mask: string | null
  currentBalance: number | null
  availableBalance: number | null
  isoCurrencyCode: string | null
}

export interface Transaction {
  id: string
  plaidTransactionId: string
  date: string
  amount: number
  name: string
  merchantName: string | null
  categoryPrimary: string | null
  categoryDetailed: string | null
  isoCurrencyCode: string | null
  pending: boolean
  tags: string[]
  notes: string | null
}

export interface CategorySpend {
  name: string | null
  total: number
}

export interface RecurringStream {
  merchantName: string
  frequency: string
  lastAmount: number
  averageAmount: number
  lastDate: string | null
  status: string
  category: string | null
}

export interface RecurringData {
  outflow: RecurringStream[]
  inflow: RecurringStream[]
  monthlyOutflow: number
}

// M7.2 — one money period, as returned by the backend (src/lib/period.ts).
export interface PeriodInfo {
  /** Start date, YYYY-MM-DD. */
  key: string
  start: string
  /** Exclusive end, YYYY-MM-DD. */
  end: string
  lastDay: string
  /** "Sep 2026" at start day 1, otherwise "Sep 10 – Oct 9". */
  label: string
  /** "September" at start day 1, otherwise "Sep 10 – Oct 9". */
  longLabel: string
  /** "Sep '26" at start day 1, otherwise "Sep 10". */
  tickLabel: string
  startDay: number
  daysInPeriod: number
  inProgress: boolean
  dayOfPeriod: number
}

export interface MonthlyTotal extends PeriodInfo {
  month:   string
  total:   number
  txCount: number
}

export interface CategorySpend {
  category:   string
  amount:     number
  color:      string
  percentage: number
}

export type BudgetStatus =
  | "on_track"
  | "warning"
  | "over"
  | "projected_over"

export interface Budget {
  id: string
  category: string
  monthlyLimit: number
  currentSpend: number
  percentUsed: number
  remaining: number
  projected: number | null
  status: BudgetStatus
  month: string
}

export interface BudgetCategoryOption {
  category: string
  color: string
}

export type Sentiment = "positive" | "negative" | "neutral"

export interface Insight {
  type: string
  headline: string
  sentiment: Sentiment
}

export interface InsightsResponse {
  summary: {
    month: string
    monthLabel: string
    income: number
    expenses: number
    netSaved: number
    savingsRate: number | null
    /** M7.2 — the period these figures cover. */
    period: PeriodInfo
  }
  topMerchants: Array<{ merchant: string; total: number; count: number }>
  largestPurchases: Array<{
    id: string; merchant: string; amount: number;
    date: string; category: string; color: string
  }>
  runway: {
    months: number | null
    cashAvailable: number
    avgMonthlyExpenses: number
    monthsOfHistory: number
  }
  highlights: Insight[]
}

export type StreamKind = "subscription" | "bill" | "income"
export type Frequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "SEMI_MONTHLY" | "ANNUALLY" | "UNKNOWN"

export interface EnrichedStream {
  merchant: string
  cleanMerchant: string
  kind: StreamKind
  category: string
  frequency: Frequency
  lastAmount: number
  lastDate: string
  monthlyAmount: number
  source: "plaid" | "custom"
  priceChange: { previousAmount: number; pctChange: number } | null
  isDuplicate: boolean
  nextChargeDate: string | null
  daysUntilNextCharge: number | null
}

export interface SubscriptionAnalysis {
  subscriptions: EnrichedStream[]
  bills: EnrichedStream[]
  upcoming: EnrichedStream[]
  alerts: Array<{ kind: "price_up" | "duplicate" | "many_streaming"; message: string }>
  totals: {
    monthlySubscriptions: number
    monthlyBills: number
    monthlyAll: number
  }
}

export type Range = "1M" | "3M" | "6M" | "1Y" | "All"

export interface NetWorthPoint {
  date: string
  netWorth: number
  assets: number
  liabilities: number
  depository: number
  investment: number
  credit: number
  loan: number
}

export interface NetWorthSummary {
  firstNetWorth: number | null
  lastNetWorth: number | null
  deltaAbs: number | null
  deltaPct: number | null
  rangeApplied: Range
  dataLimited: boolean
  daysCovered: number
}

export interface NetWorthResponse {
  history: NetWorthPoint[]
  summary: NetWorthSummary
  /** M7.2 — dates (YYYY-MM-DD, all present in history) where a new money period begins. */
  periodMarkers?: string[]
  periodStartDay?: number
}

/** What a transaction IS, as decided by the backend classifier (M7.3). */
export type RowKind =
  | "spend"
  | "income"
  | "card_payment"
  | "internal_transfer"
  | "savings_transfer"
  | "refund"
  | "payment_app_in"
  | "credit_inflow_not_income"
  | "unclassified_inflow"

export interface RowMeaning {
  kind: RowKind
  /** Chip text, e.g. "Card payment". Ordinary spending is labelled "Spending". */
  label: string
}

export interface EnrichedTransaction {
  id: string
  name: string
  displayName: string
  amount: number
  date: string
  category: string
  rawCategory: string | null
  color: string
  logoUrl: string | null
  tags: string[]
  notes: string | null
  account: string
  meaning: RowMeaning
}

export interface SearchResult {
  transactions: EnrichedTransaction[]
  nextCursor: string | null
  totalCount: number | null
}

export interface CategoryOption {
  category: string
  color: string
}

export type Severity = "high" | "medium" | "low" | "positive"
export type AlertKind =
  | "overspending" | "low_balance" | "missed_paycheck"
  | "large_transaction" | "subscription_price_up"
  | "budget_exceeded" | "budget_projected_over" | "positive_milestone"

export interface Alert {
  id: string
  kind: AlertKind
  severity: Severity
  title: string
  body: string
  data: Record<string, unknown>
  triggeredAt: string         // ISO
  dismissedAt: string | null
}

export interface WeeklyDigest {
  weekStart: string
  weekEnd: string
  spent: number
  income: number
  netSaved: number
  newAlertCount: number
  biggestMover: { category: string; pctChange: number } | null
  summary: string
}

export type GoalType = "savings" | "emergency_fund" | "vacation" | "debt_payoff"
export type GoalStatus = "on_track" | "behind" | "ahead" | "complete" | "new"

export interface EnrichedGoal {
  id: string
  type: GoalType
  name: string
  targetAmount: number | null
  startAmount: number | null
  currentAmount: number
  progressPct: number
  deadline: string | null
  accountId: string | null
  data: Record<string, unknown>
  status: GoalStatus
  hint: string | null
  createdAt: string
}

export type PlaidItemStatus = "healthy" | "login_required" | "pending_expiration" | "revoked" | "error"

export interface PlaidItemSummary {
  id: string
  institutionName: string | null
  institutionId: string | null
  status: PlaidItemStatus
  errorCode: string | null
  lastSyncedAt: string | null
  accountCount: number
}

export type ScoreGrade = "excellent" | "good" | "fair" | "needs_work" | "at_risk"
export type ScoreComponentKey = "savingsRate" | "spendingControl" | "debtLoad" | "growthTrend"

export interface ScoreComponent {
  value: number | null
  weight: number
  hint: string
  dataLimited: boolean
}

export interface FinancialScore {
  total: number
  grade: ScoreGrade
  components: Record<ScoreComponentKey, ScoreComponent>
}