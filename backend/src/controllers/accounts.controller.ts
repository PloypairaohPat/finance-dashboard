import { Request, Response } from 'express'
import { fetchAccounts }     from '../services/accounts.service'
import { getUserId }         from '../middleware/auth'

export async function getAccounts(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserId(req)
    const accounts = await fetchAccounts(userId)
    res.json({ accounts })
  } catch (err: any) {
    console.error('❌ getAccounts:', err.message)
    res.status(500).json({ error: 'Failed to fetch accounts' })
  }
}
