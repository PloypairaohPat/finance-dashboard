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

export interface Budget {
  category:     string
  monthlyLimit: number
  currentSpend: number
  percentUsed:  number
  remaining:    number
  status:       "on_track" | "warning" | "over"
  month:        string
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