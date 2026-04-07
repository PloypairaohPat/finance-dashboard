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