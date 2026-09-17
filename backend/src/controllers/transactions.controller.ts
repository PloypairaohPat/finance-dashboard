import { Request, Response } from 'express'
import {
  fetchTransactions,
  fetchCurrentPeriodCategorySpend,
  fetchCategoryComparison,
  fetchMonthlyTotals,
  searchTransactions,
  updateTransaction,
  fetchUserTags,
  TransactionUpdateError,
} from '../services/transactions.service'
import { ASSIGNABLE_CATEGORIES, CATEGORY_COLORS } from '../lib/categoryMap'
import { getUserId } from '../middleware/auth'
import { getPeriodStartDay } from '../services/user.service'

export async function getTransactions(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const transactions = await fetchTransactions(userId)
    res.json({ transactions })
  } catch (err: any) {
    console.error('❌ getTransactions:', err.message)
    res.status(500).json({ error: 'Failed to fetch transactions' })
  }
}

export async function getCategories(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    // The Overview "Spending breakdown" covers the current money period, the
    // same window as Month over month beside it (M7.2).
    const startDay = await getPeriodStartDay(userId)
    const { categories, period } = await fetchCurrentPeriodCategorySpend(userId, startDay)
    res.json({ categories, period })
  } catch (err: any) {
    console.error('❌ getCategories:', err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
}

export async function getCategoryComparison(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    // `months` is the historical name; it is a count of periods (M7.2).
    const periods = Math.min(Math.max(Number(req.query.months) || 3, 1), 12)
    const startDay = await getPeriodStartDay(userId)
    const data = await fetchCategoryComparison(userId, periods, startDay)
    res.json(data)
  } catch (err: any) {
    console.error('❌ getCategoryComparison:', err.message)
    res.status(500).json({ error: 'Failed to fetch comparison' })
  }
}

export async function getTrends(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    // `months` is the historical name; it is a count of periods (M7.2).
    const periods = Math.min(Math.max(req.query.months ? parseInt(req.query.months as string, 10) || 12 : 12, 1), 24)
    const startDay = await getPeriodStartDay(userId)
    const trends = await fetchMonthlyTotals(userId, periods, startDay)
    res.json({ trends, periodStartDay: startDay })
  } catch (err: any) {
    console.error('❌ getTrends:', err.message)
    res.status(500).json({ error: 'Failed to fetch trends' })
  }
}

// M5.7 Step 2: cursor pagination + enriched response
export async function getTransactionSearch(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const { q, category, dateFrom, dateTo, minAmount, maxAmount, tags, cursor, limit } = req.query

    const tagsArr = typeof tags === "string"
      ? tags.split(",").map(s => s.trim()).filter(Boolean)
      : undefined

    const result = await searchTransactions(userId, {
      q:          q         as string | undefined,
      category:   category  as string | undefined,
      dateFrom:   dateFrom  as string | undefined,
      dateTo:     dateTo    as string | undefined,
      minAmount:  minAmount !== undefined ? Number(minAmount) : undefined,
      maxAmount:  maxAmount !== undefined ? Number(maxAmount) : undefined,
      tags:       tagsArr,
      cursor:     cursor    as string | undefined,
      limit:      limit     !== undefined ? Number(limit) : undefined,
    })

    res.json(result)
  } catch (err: any) {
    console.error("searchTransactions error:", err.message)
    res.status(500).json({ error: "Failed to search transactions" })
  }
}

export async function patchTransaction(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const id = req.params.id as string
    const { tags, notes, category } = req.body
    const updated = await updateTransaction(userId, id, { tags, notes, category })
    res.json({ ok: true, transaction: updated })
  } catch (err: any) {
    if (err instanceof TransactionUpdateError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error("patchTransaction:", err.message)
    res.status(500).json({ error: "Update failed" })
  }
}

// The categories a transaction can be moved to — also every bucket a row can land
// in, so the list's filter uses it too. Not /budgets/categories: that includes
// Subscriptions, which no Plaid code maps to, so no row can ever be in it.
export function getAssignableCategories(_req: Request, res: Response): void {
  res.json(ASSIGNABLE_CATEGORIES.map(category => ({ category, color: CATEGORY_COLORS[category] })))
}

// M5.7 Step 4: Suggested tags for TransactionDetail
export async function getUserTags(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    res.json(await fetchUserTags(userId))
  } catch (err: any) {
    console.error("getUserTags error:", err.message)
    res.status(500).json({ error: "Failed to fetch tags" })
  }
}
