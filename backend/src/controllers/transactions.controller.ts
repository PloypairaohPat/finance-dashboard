import { Request, Response } from 'express'
import {
  fetchTransactions,
  fetchCategorySpend,
  fetchCategoryComparison,
  fetchMonthlyTotals,
  searchTransactions,
  updateTransaction,
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
    const categories = await fetchCategorySpend(userId)  // M5.2: was fetchCategoryTotals
    res.json({ categories })
  } catch (err: any) {
    console.error('❌ getCategories:', err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
}

// M5.2: New handler for month-over-month comparison
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

export async function searchTransactionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const filters = {
      q:          req.query.q         as string | undefined,
      category:   req.query.category  as string | undefined,
      dateFrom:   req.query.dateFrom  as string | undefined,
      dateTo:     req.query.dateTo    as string | undefined,
      minAmount:  req.query.minAmount ? parseFloat(req.query.minAmount as string) : undefined,
      maxAmount:  req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : undefined,
      tag:        req.query.tag       as string | undefined,
      sortBy:     req.query.sortBy    as string | undefined,
      limit:      req.query.limit     ? parseInt(req.query.limit  as string, 10) : undefined,
      offset:     req.query.offset    ? parseInt(req.query.offset as string, 10) : undefined,
    }
    const result = await searchTransactions(userId, filters)
    res.json(result)
  } catch (err: any) {
    console.error("searchTransactions:", err.message)
    res.status(500).json({ error: "Search failed" })
  }
}

export async function patchTransaction(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const id = req.params.id as string
    const { tags, notes } = req.body
    const updated = await updateTransaction(id, { tags, notes })
    res.json({ ok: true, transaction: updated })
  } catch (err: any) {
    console.error("patchTransaction:", err.message)
    res.status(500).json({ error: "Update failed" })
  }
}
