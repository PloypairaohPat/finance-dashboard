import { Request, Response } from 'express'
import { PlaidApi }          from 'plaid'
import { fetchRecurring }    from '../services/recurring.service'
import { getUserId }         from '../middleware/auth'

export function makeRecurringController(plaidClient: PlaidApi) {
  return {
    async getRecurring(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const result = await fetchRecurring(plaidClient, userId)
        res.json(result)
      } catch (err: any) {
        console.error('❌ getRecurring:', err.response?.data || err.message)
        res.status(500).json({ error: 'Failed to fetch recurring streams' })
      }
    },
  }
}
