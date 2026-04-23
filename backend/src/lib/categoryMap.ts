// M5.2 — Single source of truth for display categories
// Used by: /categories, /categories/comparison, budgets (M5.3), alerts (M5.8)

export const DISPLAY_CATEGORIES = [
  "Housing", "Food & Dining", "Shopping", "Transportation",
  "Bills & Utilities", "Subscriptions", "Entertainment",
  "Travel", "Debt", "Other",
] as const

export type DisplayCategory = typeof DISPLAY_CATEGORIES[number]

export const CATEGORY_COLORS: Record<DisplayCategory, string> = {
  "Housing":         "#4a9eff",
  "Food & Dining":   "#00e87a",
  "Shopping":        "#f0a030",
  "Transportation":  "#a78bfa",
  "Bills & Utilities": "#ff7a6b",
  "Subscriptions":   "#38bdf8",
  "Entertainment":   "#fb7185",
  "Travel":          "#34d399",
  "Debt":            "#e85555",
  "Other":           "#5a7a5a",
}

// Prefix-matching map — order matters (more specific prefixes first)
const PREFIX_MAP: Array<[string, DisplayCategory]> = [
  ["RENT_AND_UTILITIES_UTILITIES",  "Bills & Utilities"],
  ["RENT_AND_UTILITIES",            "Bills & Utilities"],
  ["HOME_IMPROVEMENT",              "Housing"],
  ["FOOD_AND_DRINK",                "Food & Dining"],
  ["GENERAL_MERCHANDISE",           "Shopping"],
  ["PERSONAL_CARE",                 "Shopping"],
  ["TRANSPORTATION",                "Transportation"],
  ["TRAVEL",                        "Travel"],
  ["ENTERTAINMENT",                 "Entertainment"],
  ["LOAN_PAYMENTS",                 "Debt"],
  ["BANK_FEES",                     "Bills & Utilities"],
  ["MEDICAL",                       "Bills & Utilities"],
  ["GENERAL_SERVICES",              "Bills & Utilities"],
]

export function mapPlaidCategory(raw: string | null | undefined): DisplayCategory {
  if (!raw) return "Other"
  const upper = raw.toUpperCase()
  for (const [prefix, display] of PREFIX_MAP) {
    if (upper.startsWith(prefix)) return display
  }
  return "Other"
}

// Categories to exclude from spending charts — income/transfers are not expenses.
export const NON_SPENDING_PREFIXES = ["INCOME", "TRANSFER_IN"]
export function isSpending(raw: string | null | undefined): boolean {
  if (!raw) return true
  const upper = raw.toUpperCase()
  return !NON_SPENDING_PREFIXES.some(p => upper.startsWith(p))
}
