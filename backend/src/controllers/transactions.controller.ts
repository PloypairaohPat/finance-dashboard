import { Request, Response } from 'express'
import {
  fetchTransactions,
  fetchCategorySpend,
  fetchCategoryComparison,
  fetchMonthlyTotals,
  searchTransactions,
  updateTransaction,
  fetchUserTags,
} from '../services/transactions.service'
import { getUserId } from '../middleware/auth'

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
    const categories = await fetchCategorySpend(userId)
    res.json({ categories })
  } catch (err: any) {
    console.error('❌ getCategories:', err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
}

export async function getCategoryComparison(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const months = Math.min(Math.max(Number(req.query.months) || 3, 1), 12)
    const data = await fetchCategoryComparison(userId, months)
    res.json(data)
  } catch (err: any) {
    console.error('❌ getCategoryComparison:', err.message)
    res.status(500).json({ error: 'Failed to fetch comparison' })
  }
}

export async function getTrends(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const months = req.query.months ? parseInt(req.query.months as string) : 12
    const trends = await fetchMonthlyTotals(userId, months)
    res.json({ trends })
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
    const updated = await updateTransaction(id, { tags, notes, category })
    res.json({ ok: true, transaction: updated })
  } catch (err: any) {
    console.error("patchTransaction:", err.message)
    res.status(500).json({ error: "Update failed" })
  }
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
