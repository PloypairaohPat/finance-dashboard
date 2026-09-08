import { Request, Response } from 'express'
import { PlaidApi } from 'plaid'
import { listPlaidItems, unlinkPlaidItem } from '../services/plaidItems.service'
import { getUserId } from '../middleware/auth'

export function makePlaidItemsController(plaidClient: PlaidApi) {
  return {
    async getPlaidItems(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        const items  = await listPlaidItems(userId)
        res.json(items)
      } catch (err: any) {
        console.error('❌ getPlaidItems:', err.message)
        res.status(500).json({ error: 'Failed to fetch linked institutions' })
      }
    },

    async deletePlaidItem(req: Request, res: Response) {
      try {
        const userId = getUserId(req)
        await unlinkPlaidItem(plaidClient, userId, req.params.id as string)
        res.json({ success: true })
      } catch (err: any) {
        console.error('❌ deletePlaidItem:', err.response?.data || err.message)
        res.status(err.message === 'PlaidItem not found' ? 404 : 500)
           .json({ error: err.message === 'PlaidItem not found' ? err.message : 'Failed to disconnect institution' })
      }
    },
  }
}
