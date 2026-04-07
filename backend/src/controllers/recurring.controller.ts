import { Request, Response } from 'express'
import { PlaidApi }          from 'plaid'
import { fetchRecurring }    from '../services/recurring.service'

export function makeRecurringController(plaidClient: PlaidApi) {
  return {
    async getRecurring(_req: Request, res: Response) {
      try {
        const result = await fetchRecurring(plaidClient)
        res.json(result)
      } catch (err: any) {
        console.error('❌ getRecurring:', err.response?.data || err.message)
        res.status(500).json({ error: 'Failed to fetch recurring streams' })
      }
    },
  }
}