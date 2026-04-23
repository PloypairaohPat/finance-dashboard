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

export interface MonthlyTotal {
  month:   string
  label:   string
  total:   number
  txCount: number
}

export interface Alert {
  type:        "large_transaction" | "new_merchant" | "monthly_pace" | "budget_exceeded"
  severity:    "warning" | "critical"
  title:       string
  description: string
  amount?:     number
  category?:   string
  date?:       string
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