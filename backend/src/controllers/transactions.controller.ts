import { Request, Response }                       from 'express'
import { fetchTransactions, fetchCategoryTotals, fetchMonthlyTotals, searchTransactions, updateTransaction } from '../services/transactions.service'

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID ?? "demo-user"

export async function getTransactions(_req: Request, res: Response): Promise<void> {
  try {
    const transactions = await fetchTransactions()
    res.json({ transactions })
  } catch (err: any) {
    console.error('❌ getTransactions:', err.message)
    res.status(500).json({ error: 'Failed to fetch transactions' })
  }
}

export async function getCategories(_req: Request, res: Response): Promise<void> {
  try {
    const categories = await fetchCategoryTotals()
    res.json({ categories })
  } catch (err: any) {
    console.error('❌ getCategories:', err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
}

export async function getTrends(req: Request, res: Response): Promise<void> {
  try {
    const months = req.query.months ? parseInt(req.query.months as string) : 12
    const trends = await fetchMonthlyTotals(months)
    res.json({ trends })
  } catch (err: any) {
    console.error('❌ getTrends:', err.message)
    res.status(500).json({ error: 'Failed to fetch trends' })
  }
}

// ── M3.3: Search endpoint ────────────────────────────────────
export async function searchTransactionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req.query.userId as string) || DEFAULT_USER_ID
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

// ── M3.3: PATCH tags / notes ─────────────────────────────────
export async function patchTransaction(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string
    const { tags, notes } = req.body
    const updated = await updateTransaction(id, { tags, notes })
    res.json({ ok: true, transaction: updated })
  } catch (err: any) {
    console.error("patchTransaction:", err.message)
    res.status(500).json({ error: "Update failed" })
  }
}