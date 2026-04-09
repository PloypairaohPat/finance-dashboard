import { Request, Response }                       from 'express'
import { fetchTransactions, fetchCategoryTotals, fetchMonthlyTotals } from '../services/transactions.service'

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